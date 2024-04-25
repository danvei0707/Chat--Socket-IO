import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import chalk from 'chalk';
import { error } from 'node:console';
import { availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import { createAdapter, setupPrimary } from '@socket.io/cluster-adapter';

if (cluster.isPrimary) {
    const numCPUs = availableParallelism();
    const numServers = 1

    // With numCPUs on the loop you create the maximum amunt of servers
    // With numServers on the loop you create the specified amount of servers
    for (let i = 0; i < numServers; i++) {
        cluster.fork({
            PORT: 3000 + i
        });
    }

    // Set up the adapter on the primary thread
    setupPrimary();
} else {
    // * Why else? Because each working process needs its own instance of the server and app
    const app = express();
    const server = createServer(app);
    const io = new Server(server, {

    //* Micro disconnections are frequent, thats how to handle them.
    // This freature allows to handle "brief disconnections", and send events back to the user.
    connectionStateRecovery: {},   // ! Doesn't work
    // Set up the adapter on each worker thread
    adapter: createAdapter()

    });


    // Use or create DB
    const db = await open({
        filename: 'chat.db',
        driver: sqlite3.Database
    });

    // Create messages table
    await db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT
        );
    `);
    // console.log(chalk.green('Messages database initiated correctly!'));

    const __dirname = dirname(fileURLToPath(import.meta.url));

    app.get('/', (req, res) => {
        res.sendFile(join(__dirname, 'index.html'));
    });



    io.on('connection', async (socket) => {
        console.log('a user connected - online');
        socket.emit('userJoined', 'A user has joined the chat');
        

        const room = 'Room 1'
        socket.join(room);
        console.log('Joining room:', room);

        // With broadcast, sends to everyone but the sender
        socket.broadcast.emit('welcomeMsg', 'Hello!')

        // When a user sends a message
        socket.on('chat message', async (msg, clientOffset, callback) => {
            // Insert the msg into the DB
            let result;
            try {
                result = await db.run('INSERT INTO messages (content) VALUES (?)', msg, clientOffset);
            }catch (e) {
                if(e.errno === 19 /* SQLITE Error */){
                // Message was already inserted
                console.log('Message already inserted');

                // Acknowledge the event - prevent from retries
                callback();
                } else {
                    console.log(e.message);
                    console.log('Retrying insertion...');
                }
                // TODO handle freature
            }

            // Send to every connected socket (including sender
            // Done in this way for simplicity
            io.emit('chat message', msg, result.lastID);        

            // Acknowledge the event - prevent from retries if it was succesful
            callback();

        });

        if (!socket.recovered) {
            // if recovery state didn't work
            try {
                await db.each('SELECT id, content FROM messages WHERE id > ?', 
                [socket.handshake.auth.serverOffset || 0],
                (_err, row) => {
                    socket.emit('chat message', row.content, row.id);
                })
            } catch (e) {
                console.log('Recovery went wrong:', error);
            }
        }

        // When a user disconnects
        socket.on('disconnect', (reason, details) => {
            console.log('user disconnected - offline');
            socket.emit('userLeft', 'A user has left the chat');
            // console.log('details:', details);
        })
    });

    // For each server forked, use its respective PORT
    const port = process.env.PORT;

    server.listen(3000, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
}