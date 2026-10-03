import asyncio
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable

import httpx


@dataclass(frozen=True)
class ImmichOperation:
    permission: str
    purpose: str
    optional: bool = False


# All calls below refer to this registry. /capabilities derives its UI list from it.
OPERATIONS = {
    "search": ImmichOperation("asset.read", "Read owned assets and their EXIF, people, and location data"),
    "user": ImmichOperation("user.read", "Read Immich user ID to exclude shared assets"),
    "detail": ImmichOperation("asset.read", "Load missing file sizes and verify thumbnails"),
    "thumbnail": ImmichOperation("asset.view", "Display a thumbnail of your latest photo", True),
    "avatar": ImmichOperation("userProfileImage.read", "Adopt Immich profile photo", True),
    "albums": ImmichOperation("album.read", "Count owned albums", True),
}


class ImmichPermissionError(Exception):
    pass


class ImmichClient:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.headers = {"x-api-key": api_key}
        self.did_full_scan = False

    async def _request(self, client: httpx.AsyncClient, operation: str, method: str, path: str, **kwargs) -> httpx.Response:
        assert operation in OPERATIONS
        response = await client.request(method, f"{self.base_url}/api{path}", headers=self.headers, **kwargs)
        if response.status_code == 403:
            raise ImmichPermissionError(f"Immich denied {OPERATIONS[operation].permission} ({operation}).")
        response.raise_for_status()
        return response

    async def _search(self, client: httpx.AsyncClient, filters: dict[str, Any]) -> dict[str, Any]:
        # Some older Immich versions expose the same search under /search/assets.
        response = await client.post(f"{self.base_url}/api/search/metadata", headers=self.headers, json=filters)
        if response.status_code == 404:
            response = await self._request(client, "search", "POST", "/search/assets", json=filters)
        elif response.status_code == 403:
            raise ImmichPermissionError("Immich denied asset.read (search).")
        else:
            response.raise_for_status()
        return response.json()

    @staticmethod
    def _page(response: dict[str, Any]) -> tuple[list[dict[str, Any]], Any]:
        assets = response.get("assets", response)
        if isinstance(assets, dict) and isinstance(assets.get('items'), list):
            return assets['items'], assets.get('nextPage')
        if isinstance(assets, list):
            return assets, None
        raise ValueError('Unexpected Immich search response; snapshot not replaced')

    async def current_user(self, client: httpx.AsyncClient) -> dict[str, Any]:
        response = await self._request(client, "user", "GET", "/users/me")
        return response.json()

    async def _list_assets(self, client: httpx.AsyncClient, visibility: str, extra: dict[str, Any] | None = None,
                           on_page: Callable[[int, int | None], None] | None = None) -> list[dict[str, Any]]:
        filters: dict[str, Any] = {"page": 1, "size": 1000, "visibility": visibility, "withExif": True, "withPeople": True, **(extra or {})}
        result: list[dict[str, Any]] = []
        seen_pages = set()
        while True:
            if filters['page'] in seen_pages:
                raise ValueError('Immich repeated a page; refusing an incomplete snapshot')
            seen_pages.add(filters['page'])
            response = await self._search(client, filters)
            items, next_page = self._page(response)
            result.extend(items)
            if on_page:
                total = response.get('assets', {}).get('total') if isinstance(response.get('assets'), dict) else None
                on_page(len(items), total if isinstance(total, int) else None)
            if isinstance(response.get('assets'), dict) and 'nextPage' in response['assets'] and next_page is None:
                break
            if next_page is not None:
                if not next_page:
                    break
                filters["page"] = int(next_page)
            elif len(items) < filters["size"]:
                break
            else:
                filters["page"] += 1
        return result

    async def list_owned_assets(self, previous: dict[str, dict] | None = None, full: bool = True,
                                progress: Callable[[str, int, int], None] | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        async with httpx.AsyncClient(timeout=60) as client:
            user = await self.current_user(client)
            scanned = 0
            estimated = max(1, len(previous or {}))

            def on_page(count: int, total: int | None) -> None:
                nonlocal scanned, estimated
                scanned += count
                if total is not None:
                    estimated = max(estimated, total)
                if progress:
                    progress("Checking assets" if not full else "Loading assets", scanned, estimated)

            timeline, archive = await asyncio.gather(
                self._list_assets(client, "timeline", {"withExif": full, "withPeople": full}, on_page),
                self._list_assets(client, "archive", {"withExif": full, "withPeople": full}, on_page),
            )
            assets = {asset["id"]: asset for asset in [*timeline, *archive] if asset.get("ownerId") == user["id"]}
            if not full and previous is not None:
                # No reliable remote deletion stream exists: the inexpensive ID pass above
                # reconciles removals and archive transitions without fetching EXIF/people.
                fields = ('updatedAt', 'checksum', 'isFavorite', 'visibility', 'localDateTime', 'duration', 'width', 'height')
                if assets and all(asset.get('updatedAt') for asset in assets.values()):
                    changed = [asset for asset in assets.values() if asset['id'] not in previous or
                               any(field in asset and asset[field] != previous[asset['id']].get(field) for field in fields)]
                    if len(changed) <= max(100, len(assets) // 4):
                        semaphore = asyncio.Semaphore(8)
                        completed = 0

                        async def refresh(asset: dict[str, Any]) -> None:
                            nonlocal completed
                            async with semaphore:
                                detail = (await self._request(client, 'detail', 'GET', f"/assets/{asset['id']}")).json()
                                if detail.get('ownerId') != user['id']:
                                    raise ValueError('Immich returned an asset with another owner')
                                assets[asset['id']] = {**asset, **detail}
                                completed += 1
                                if progress:
                                    progress("Loading changes", completed, len(changed))

                        await asyncio.gather(*(refresh(asset) for asset in changed))
                        changed_ids = {asset['id'] for asset in changed}
                        for asset_id, asset in list(assets.items()):
                            if asset_id in previous and asset_id not in changed_ids:
                                assets[asset_id] = previous[asset_id]
                        return user, list(assets.values())
                # Old Immich releases may not expose an update marker. Use a safe full scan.
                return await self.list_owned_assets(full=True, progress=progress)
            self.did_full_scan = True
            missing = [asset for asset in assets.values() if asset_size(asset) is None]
            semaphore = asyncio.Semaphore(8)

            async def enrich(asset: dict[str, Any]) -> None:
                async with semaphore:
                    try:
                        detail = (await self._request(client, "detail", "GET", f"/assets/{asset['id']}")).json()
                        if detail.get("ownerId") == user["id"]:
                            merged = {**asset, **detail}
                            merged["exifInfo"] = {**(asset.get("exifInfo") or {}), **(detail.get("exifInfo") or {})}
                            assets[asset["id"]] = merged
                    except (httpx.HTTPError, ImmichPermissionError):
                        pass  # The summary will report incomplete size coverage.

            await asyncio.gather(*(enrich(asset) for asset in missing))
            return user, list(assets.values())

    async def check_connection(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30) as client:
            user = await self.current_user(client)
            await self._search(client, {"page": 1, "size": 1, "visibility": "timeline", "withExif": True, "withPeople": True})
            return user

    async def album_metadata(self, owner_id: str, previous_albums: list[dict] | None = None,
                             full: bool = True, progress: Callable[[str, int, int], None] | None = None) -> tuple[list[dict] | None, set[str] | None]:
        async with httpx.AsyncClient(timeout=60) as client:
            # Search is authoritative even when album details omit or paginate assets.
            try:
                response = await self._request(client, "albums", "GET", "/albums", params={"isOwned": "true"})
                albums = response.json()
                if not isinstance(albums, list):
                    raise ValueError('Unexpected Immich album response')
                # V3 omits ownerId; isOwned is the server-side ownership filter.
                # Older versions may still include ownerId, so validate it when present.
                owned = sorted(({"id": a["id"], "albumName": a.get("albumName"), "updatedAt": a.get("updatedAt"), "assetCount": a.get("assetCount")}
                                for a in albums if a.get("ownerId", owner_id) == owner_id), key=lambda album: album['id'])
            except (httpx.HTTPError, ImmichPermissionError):
                owned = None
            try:
                scanned = 0
                estimated = 1

                def on_unalbumed_page(count: int, total: int | None) -> None:
                    nonlocal scanned, estimated
                    scanned += count
                    estimated = max(estimated, scanned, total or 0)
                    if progress:
                        progress("Checking assets without albums", scanned, estimated)

                timeline, archive = await asyncio.gather(
                    self._list_assets(client, "timeline", {"isNotInAlbum": True, "withExif": False, "withPeople": False}, on_unalbumed_page),
                    self._list_assets(client, "archive", {"isNotInAlbum": True, "withExif": False, "withPeople": False}, on_unalbumed_page),
                )
                without_album = {a["id"] for a in [*timeline, *archive] if a.get("ownerId") == owner_id}
            except (httpx.HTTPError, ImmichPermissionError):
                without_album = None
            if owned is not None:
                semaphore = asyncio.Semaphore(4)
                old_albums = {album['id']: album for album in previous_albums or []}
                completed = 0

                async def album_assets(album: dict) -> None:
                    nonlocal completed
                    async with semaphore:
                        try:
                            old = old_albums.get(album['id'])
                            if (not full and old and old.get('updatedAt') and old.get('updatedAt') == album.get('updatedAt')
                                    and old.get('assetCount') == album.get('assetCount') and old.get('asset_ids') is not None):
                                album['asset_ids'] = old['asset_ids']
                                return
                            timeline, archive = await asyncio.gather(
                                self._list_assets(client, "timeline", {"albumIds": [album["id"]], "withExif": False, "withPeople": False}),
                                self._list_assets(client, "archive", {"albumIds": [album["id"]], "withExif": False, "withPeople": False}),
                            )
                            album["asset_ids"] = sorted({asset["id"] for asset in [*timeline, *archive] if asset.get("ownerId") == owner_id})
                        except (httpx.HTTPError, ImmichPermissionError, ValueError):
                            album["asset_ids"] = None
                        finally:
                            completed += 1
                            if progress:
                                progress('Checking albums', completed, len(owned))

                await asyncio.gather(*(album_assets(album) for album in owned))
            return owned, without_album

    async def thumbnail(self, asset_id: str, owner_id: str) -> httpx.Response:
        async with httpx.AsyncClient(timeout=30) as client:
            asset = (await self._request(client, "detail", "GET", f"/assets/{asset_id}")).json()
            if asset.get("ownerId") != owner_id:
                raise PermissionError("Asset does not belong to this user")
            return await self._request(client, "thumbnail", "GET", f"/assets/{asset_id}/thumbnail", params={"size": "thumbnail"})

    async def thumbnail_cached(self, asset_id: str) -> httpx.Response:
        # Caller has already checked the asset against this account's owned cache.
        async with httpx.AsyncClient(timeout=30) as client:
            return await self._request(client, "thumbnail", "GET", f"/assets/{asset_id}/thumbnail", params={"size": "thumbnail"})

    async def avatar(self, owner_id: str) -> httpx.Response:
        async with httpx.AsyncClient(timeout=30) as client:
            return await self._request(client, "avatar", "GET", f"/users/{owner_id}/profile-image")


def asset_size(asset: dict[str, Any]) -> int | None:
    for value in (asset.get("fileSizeInByte"), (asset.get("exifInfo") or {}).get("fileSizeInByte")):
        try:
            size = int(value)
            if size > 0:
                return size
        except (TypeError, ValueError):
            pass
    return None
