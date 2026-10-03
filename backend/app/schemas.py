from datetime import date as CalendarDate, datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, HttpUrl

CACHE_VERSION = 20


class AccountInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: EmailStr


class BootstrapInput(AccountInput):
    password: str = Field(min_length=12, max_length=128)


class InvitationInput(AccountInput):
    pass


class AcceptInvitationInput(BaseModel):
    token: str = Field(min_length=32, max_length=200)
    password: str = Field(min_length=12, max_length=128)


class LoginInput(BaseModel):
    email: EmailStr
    password: str


class PasswordInput(BaseModel):
    current_password: str
    new_password: str = Field(min_length=12, max_length=128)


class ProfileInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    profile_icon: str = Field(default="camera", max_length=30)


class ConnectionInput(BaseModel):
    immich_url: HttpUrl
    api_key: str = Field(min_length=1, max_length=2000)


class UserOut(BaseModel):
    id: int
    email: EmailStr
    name: str
    is_admin: bool
    profile_icon: str
    immich_url: str | None
    has_api_key: bool
    has_immich_avatar: bool


class AuthOut(BaseModel):
    user: UserOut
    csrf_token: str


class MemberOut(BaseModel):
    id: int
    email: EmailStr
    name: str
    is_admin: bool
    joined: bool


class InvitationOut(BaseModel):
    user: MemberOut
    token: str


class ConnectionOut(BaseModel):
    ok: bool
    message: str


class DeviceRuleInput(BaseModel):
    make: str = Field(max_length=200)
    model: str = Field(max_length=200)
    device_name: str | None = Field(default=None, max_length=300)
    manufacturer: str | None = Field(default=None, max_length=200)
    category: Literal["Mobile device", "Camera", "Other"] | None = None


class PermissionOut(BaseModel):
    permission: str
    purpose: str
    optional: bool = False


class ApiCapabilitiesOut(BaseModel):
    permissions: list[PermissionOut]


class CountPoint(BaseModel):
    label: str
    count: int


class NumericPoint(CountPoint):
    value: float
    lower: float | None = None
    upper: float | None = None
    upper_inclusive: bool = False


class AssetQueryInput(BaseModel):
    kind: Literal["asset", "device", "manufacturer", "distribution", "date", "anniversary", "week", "week_hour", "month", "weekday", "hour", "year", "orientation", "dimensions"]
    asset_id: str | None = Field(default=None, max_length=100)
    metric: Literal["assets", "photos", "videos", "geo", "people", "favorites"] = "assets"
    orientation: Literal["portrait", "landscape", "unknown"] | None = None
    frame_width: int | None = Field(default=None, ge=1, le=100000)
    frame_height: int | None = Field(default=None, ge=1, le=100000)
    name: str | None = Field(default=None, max_length=300)
    source: Literal["device", "manufacturer"] | None = None
    raw: bool = False
    category: str | None = Field(default=None, max_length=100)
    field: Literal["iso", "focal", "aperture", "exposure", "video", "altitude"] | None = None
    favorite_only: bool = False
    geo_only: bool = False
    people_only: bool = False
    lower: float | None = None
    upper: float | None = None
    upper_inclusive: bool = False
    date: str | None = Field(default=None, max_length=10)
    start: str | None = Field(default=None, max_length=10)
    end: str | None = Field(default=None, max_length=10)
    year: int | None = Field(default=None, ge=1900, le=2200)
    scope_year: int | None = Field(default=None, ge=1900, le=2200)
    scope_start: CalendarDate | None = None
    scope_end: CalendarDate | None = None
    month: int | None = Field(default=None, ge=1, le=12)
    weekday: int | None = Field(default=None, ge=0, le=6)
    hour: int | None = Field(default=None, ge=0, le=23)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=36, ge=1, le=60)


class NumericDistribution(BaseModel):
    points: list[NumericPoint] = []
    minimum: float | None = None
    maximum: float | None = None
    median: float | None = None
    mean: float | None = None
    mode: float | None = None
    mode_count: int = 0
    p99: float | None = None
    sample_count: int = 0


class DevicePoint(BaseModel):
    name: str
    count: int
    manufacturer: str = "Unknown manufacturer"
    category: str = "Other"
    manufacturer_variants: list[str] = []
    photos: int = 0
    videos: int = 0
    geo: int = 0
    people: int = 0
    favorites: int = 0


class YearPoint(BaseModel):
    year: int
    label: str | None = None
    photos: int
    videos: int
    assets: int
    geo: int = 0
    people: int = 0
    favorites: int = 0
    cumulative_photos: int
    cumulative_videos: int
    cumulative_assets: int
    cumulative_geo: int = 0
    cumulative_people: int = 0
    cumulative_favorites: int = 0
    average_asset_bytes: float | None
    average_photo_bytes: float | None
    average_video_bytes: float | None
    average_geo_bytes: float | None = None
    average_people_bytes: float | None = None
    average_favorites_bytes: float | None = None
    resolution_count: int = 0
    average_megapixels: float | None = None
    minimum_megapixels: float | None = None
    maximum_megapixels: float | None = None


class WeekPoint(BaseModel):
    year: int
    week_start: str
    photos: int
    videos: int
    geo: int
    people: int = 0
    assets: int = 0
    favorites: int = 0


class DayPoint(BaseModel):
    date: str
    photos: int
    videos: int
    assets: int
    geo: int
    people: int
    favorites: int = 0


class HourWeekPoint(BaseModel):
    weekday: int
    hour: int
    assets: int
    photos: int
    videos: int
    geo: int
    people: int
    favorites: int = 0


class ScorePoint(BaseModel):
    key: Literal["time", "iso", "frequency", "orientation", "device", "media"]
    value: float | None = None
    eligible_count: int = 0
    excluded_count: int = 0
    population_count: int = 0


class WeeklyScorePoint(BaseModel):
    week_start: str
    photo_count: int
    video_count: int
    scores: dict[str, float | None]


class AnnualScorePoint(BaseModel):
    year: int
    photo_count: int
    video_count: int
    scores: dict[str, float | None]


class ParameterMoment(BaseModel):
    count: int = 0
    mean: float | None = None
    std: float | None = None


class ParameterSlice(BaseModel):
    axis: Literal["hour", "month", "year"]
    bucket: int
    segment: Literal["all", "favorites", "geo", "people", "camera", "mobile"]
    iso: ParameterMoment = ParameterMoment()
    focal: ParameterMoment = ParameterMoment()
    aperture: ParameterMoment = ParameterMoment()


class StreakPauseBucket(BaseModel):
    label: str
    count: int
    average_pause_days: float


class PhotoProfile(BaseModel):
    photo_days: int = 0
    photos: int = 0
    favorite_photos: int = 0
    photos_per_photo_day: float | None = None
    average_streak_days: float | None = None
    average_pause_days: float | None = None
    average_cycle_days: float | None = None
    photos_per_streak_day: float | None = None
    maximum_photos_per_streak_day: int | None = None
    streak_vs_normal_ratio: float | None = None
    streak_pause_correlation: float | None = None
    long_streak_day_percent: float | None = None
    streak_distribution: list[CountPoint] = []
    pause_distribution: list[CountPoint] = []
    streak_pause_buckets: list[StreakPauseBucket] = []
    indices: dict[str, float | None] = {}


class AnnualPhotoProfile(BaseModel):
    year: int
    profile: PhotoProfile


class HeatmapSlice(BaseModel):
    date: str
    hour: int
    device: str
    manufacturer: str
    raw_manufacturer: str
    category: str
    orientation: str
    media: str
    assets: int = 0
    photos: int = 0
    videos: int = 0
    geo: int = 0
    people: int = 0
    favorites: int = 0


class FrameSegment(BaseModel):
    category: str
    photos: int = 0
    geo: int = 0
    people: int = 0
    favorites: int = 0


class FramePoint(BaseModel):
    width: int
    height: int
    count: int
    segments: list[FrameSegment] = []


class ExposurePoint(BaseModel):
    asset_id: str
    iso: float
    shutter_seconds: float
    f_number: float
    year: int | None = None
    device: str
    category: str
    geo: bool = False
    people: bool = False
    favorite: bool = False


class OrientationCounts(BaseModel):
    assets: int = 0
    photos: int = 0
    videos: int = 0


class TimelineEvent(BaseModel):
    id: str
    at: str
    category: Literal["beginning", "device", "milestone", "record", "pause"]
    title: str
    detail: str
    asset_id: str | None = None
    day: str | None = None
    metric: Literal["assets", "photos", "videos"] = "assets"


class LibraryStatsOut(BaseModel):
    cache_version: int = CACHE_VERSION
    timeline: list[TimelineEvent] = []
    favorite_count: int = 0
    album_count: int | None = None
    unalbumed_asset_count: int | None = None
    unalbumed_photo_count: int | None = None
    unalbumed_video_count: int | None = None
    live_photo_video_count: int = 0
    days: list[DayPoint] = []
    hours_of_week: list[HourWeekPoint] = []
    asset_count: int
    photo_count: int
    video_count: int
    other_count: int
    total_bytes: int | None
    photo_bytes: int | None
    video_bytes: int | None
    average_asset_bytes: float | None
    average_photo_bytes: float | None
    average_video_bytes: float | None
    missing_size_count: int
    bit_count: int | None
    sand_cubic_meters: float | None
    print_area_square_meters: float
    print_tennis_courts: float
    print_stack_meters: float
    print_weight_kg: float
    devices: list[DevicePoint]
    manufacturers: list[DevicePoint] = []
    raw_manufacturers: list[DevicePoint] = []
    average_megapixels: float | None
    resolution_count: int
    most_used_iso: int | None
    most_used_focal_length_mm: float | None
    video_duration_seconds: float
    average_video_duration_seconds: float | None = None
    duration_missing_count: int
    exposure_seconds: float
    exposure_missing_count: int
    person_count: int
    detected_people_count: int = 0
    photos_with_people_count: int
    people_per_photo_with_people: float | None
    people_per_photo: float | None
    geotagged_count: int
    country_count: int
    top_country: str | None = None
    top_country_asset_count: int = 0
    continent_count: int
    continents: list[str] = []
    first_date: datetime | None
    last_date: datetime | None
    timespan_days: int | None
    busiest_day: str | None
    busiest_day_count: int
    longest_pause_start: str | None
    longest_pause_end: str | None
    longest_pause_days: int
    longest_day_streak: int
    longest_day_streak_start: str | None = None
    longest_day_streak_end: str | None = None
    longest_week_streak: int
    longest_week_streak_start: str | None = None
    longest_week_streak_end: str | None = None
    undated_count: int
    by_month: list[CountPoint]
    by_weekday: list[CountPoint]
    by_hour: list[CountPoint]
    iso_distribution: NumericDistribution = NumericDistribution()
    focal_distribution: NumericDistribution = NumericDistribution()
    exposure_distribution: NumericDistribution = NumericDistribution()
    video_duration_distribution: NumericDistribution = NumericDistribution()
    years: list[YearPoint]
    months: list[YearPoint] = []
    weeks: list[WeekPoint]
    heatmap_slices: list[HeatmapSlice] = []
    frame_formats: list[FramePoint] = []
    frame_format_covered_count: int = 0
    exposure_points: list[ExposurePoint] = []
    photo_days_year: int | None = None
    photo_days_count: int = 0
    photo_days_total_days: int = 0
    photo_days_percent: float | None = None
    latest_photo_id: str | None
    first_asset_id: str | None = None
    last_asset_id: str | None = None
    busiest_day_asset_id: str | None = None
    altitude_photo_count: int = 0
    direction_photo_count: int = 0
    altitude_distribution: NumericDistribution = NumericDistribution()
    portrait: OrientationCounts = OrientationCounts()
    landscape: OrientationCounts = OrientationCounts()
    orientation_unknown: OrientationCounts = OrientationCounts()
    scores: list[ScorePoint] = []
    weekly_scores: list[WeeklyScorePoint] = []
    annual_scores: list[AnnualScorePoint] = []
    parameter_slices: list[ParameterSlice] = []
    photo_profile: PhotoProfile = PhotoProfile()
    annual_photo_profiles: list[AnnualPhotoProfile] = []
