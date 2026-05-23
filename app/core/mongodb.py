from motor.motor_asyncio import AsyncIOMotorClient
from typing import Optional

client: Optional[AsyncIOMotorClient] = None
DB_NAME = "camstream"

def get_client() -> Optional[AsyncIOMotorClient]:
    return client

def get_database():
    if client is None:
        raise RuntimeError("Mongo client is not initialized")
    return client[DB_NAME]

def init_client(uri: str = "mongodb://localhost:27017") -> AsyncIOMotorClient:
    global client
    client = AsyncIOMotorClient(uri)
    return client

def close_client():
    global client
    if client:
        client.close()
        client = None
