import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import chalk from 'chalk';


const db = await open({
    filename: 'chat.db',
    driver: sqlite3.Database
});

await db.exec(`
    DROP TABLE IF EXISTS messages;
`)

await db.exec(`
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT,
    clientOffset TEXT UNIQUE,
    content TEXT
);
`);
console.log(chalk.yellow.bold('Messages database restored correctly!'));