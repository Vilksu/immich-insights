from functools import lru_cache
from pathlib import Path
from cryptography.fernet import Fernet
from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    # DATABASE_URL remains available for development and custom deployments.
    # Docker Compose passes separate fields so passwords do not need URL encoding.
    database_url: str | None = None
    database_host: str | None = None
    database_port: int = 5432
    postgres_db: str = "immich_insights"
    postgres_user: str = "immich_insights"
    postgres_password: SecretStr | None = None
    # Optional override for installations that manage their own secret.
    # Otherwise a key is generated once and stored in app_secret_file.
    app_encryption_key: str | None = None
    app_secret_file: str = "./data/fernet.key"
    app_cors_origins: str = "http://localhost:5173"
    app_cookie_secure: bool = False

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.app_cors_origins.split(",") if origin.strip()]

    def sqlalchemy_database_url(self) -> str | URL:
        if self.database_url:
            return self.database_url
        if self.database_host:
            if not self.postgres_password:
                raise ValueError("POSTGRES_PASSWORD is required when DATABASE_HOST is set")
            return URL.create(
                "postgresql+psycopg",
                username=self.postgres_user,
                password=self.postgres_password.get_secret_value(),
                host=self.database_host,
                port=self.database_port,
                database=self.postgres_db,
            )
        return "sqlite:///./insights.db"

    def encryption_key(self) -> bytes:
        if self.app_encryption_key:
            key = self.app_encryption_key.encode()
            Fernet(key)  # Validate an explicitly configured key at startup.
            return key

        key_path = Path(self.app_secret_file)
        if key_path.exists():
            key = key_path.read_bytes().strip()
            Fernet(key)
            return key

        key_path.parent.mkdir(parents=True, exist_ok=True)
        key = Fernet.generate_key()
        key_path.write_bytes(key + b"\n")
        key_path.chmod(0o600)
        return key


@lru_cache
def get_settings() -> Settings:
    return Settings()
