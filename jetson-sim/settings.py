from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    RABBITMQ_URL: str = "amqp://guest:guest@localhost:5672/"
    FRAME_INTERVAL_MS: float = 800
    ANOMALY_THRESHOLD: float = 0.75
    DATASET_PATH: str = "/data/images"
    API_KEY: str = "dev-insecure-key"
    ALLOWED_ORIGIN: str = "http://localhost:3000"


settings = Settings()
