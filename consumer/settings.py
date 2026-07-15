from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql+asyncpg://nextex:nextex@localhost:5432/nextex"
    RABBITMQ_URL: str = "amqp://guest:guest@localhost:5672/"
    API_KEY: str = "dev-insecure-key"
    ALLOWED_ORIGIN: str = "http://localhost:3000"


settings = Settings()
