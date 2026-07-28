const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 3309,
  user: process.env.DB_USER || "travel_planner_user",
  password: process.env.DB_PASSWORD || "travel_planner_pass",
  database: process.env.DB_NAME || "travel_planner",
  waitForConnections: true,
  connectionLimit: 10
});

async function pingDb() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
    return true;
  } finally {
    conn.release();
  }
}

module.exports = { pool, pingDb };
