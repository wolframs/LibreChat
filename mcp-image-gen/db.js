import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || "mongodb://mongodb:27017/LibreChat";
let dbClient = null;

export async function getDb() {
  if (!dbClient) {
    dbClient = new MongoClient(MONGO_URI);
    await dbClient.connect();
    console.log("Connected to MongoDB directly from MCP Server!");
  }
  return dbClient.db();
}

export async function closeDb() {
  if (dbClient) {
    await dbClient.close();
    dbClient = null;
  }
}
