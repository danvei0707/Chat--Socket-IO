import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import chalk from 'chalk';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { error, log } from 'node:console';
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

    const users = {}

     // Use or create DB
     const db = await open({
        filename: 'chat.db',
        driver: sqlite3.Database
        });
    
        // Create messages table
        await db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nickname TEXT,
                clientOffset TEXT UNIQUE,
                content TEXT
            );
        `);
        console.log(chalk.green('Messages database initiated correctly!'));

    // Send our 'index.html' to the user
    const __dirname = dirname(fileURLToPath(import.meta.url));
    app.get('/', (req, res) => {
        res.sendFile(join(__dirname, 'index.html'));
    });


    // When a new socket connects
    io.on('connection', async (socket) => {
        console.log('New user connected:', chalk.gray(`${socket.id}`));
        // socket.emit('userJoined', `New user connected (${socket.id})`);


        socket.on('setNickname', (nickname, callback) => {
            let bool = true;
            const recipient = socket.id;
            if (nickname && !users[nickname]) {
                users[nickname] = {
                    isOnline: true,
                    connectionId: socket.id
                }
                socket.nickname = nickname;
                socket.emit('isNicknameValid', { recipient, bool }, users);

                // Verified: actually joining the chat => notify all users but the sender
                console.log(`${nickname} joined the chat`);         
                socket.broadcast.emit('userConnectionStatus', nickname,'joined', users)

                // Acknowledge the event: prevent from retries (error)
                callback();
            } else {
                // Inform user that the nickname is already in use
                console.log('Repeated nickname', socket.id);
                bool = false
                
                console.log(recipient, bool);

                socket.emit('isNicknameValid', { recipient, bool });

                // Acknowledge the event: prevent from retries (error)
                callback();
            }
        });

        //TODO Fordward him to a room
        // const room = 'Room 1'
        // socket.join(room);
        // console.log('Joining room:', room);

        socket.on('set username', async (name) => {
            console.log(socket);
            console.log(name);
        })

        // When a user sends a message
        socket.on('chat message', async (msg, clientOffset, callback) => {
                // Insert the msg into the DB
            let result;
            try {
                //! Strange functioning of client offsets
                result = await db.run('INSERT INTO messages (nickname, content) VALUES (?, ?)', [socket.nickname || 'User', msg]);
            }catch (e) {
                if(e.errno === 19 /* SQLITE Error */){
                // Message was already inserted
                console.log('Message already inserted');

                // Acknowledge the event: prevent from retries (error)
                callback();
                } else {
                    console.log(e);
                    console.log(e.message);
                    console.log('Retrying insertion...');
                }
            }
            // Send message to every connected socket (including sender, for simplicity)
            io.emit('chat message', socket.nickname, msg, result.lastID);        

            // Acknowledge the event: prevent from retries (success)
            callback();
        });

        // if recovery state (of const 'io') didn't work 
        if (!socket.recovered) {
            try {
                // Update the chat with the messages not recieved while disconnected
                await db.each('SELECT id, nickname, content FROM messages WHERE id > ?', 
                [socket.handshake.auth.serverOffset || 0],
                (_err, row) => {
                    socket.emit('chat message', row.nickname, row.content, row.id);
                })
            } catch (e) {
                console.log('Recovery went wrong:', error);
            }
        }

        // When a user disconnects
        socket.on('disconnect', (reason, details) => {
            const nickname = socket.nickname

            //TODO Set status offline
         if (nickname){
            users[nickname].isOnline = false
                    
            io.emit('userConnectionStatus', nickname, 'left', users);
            // console.log('details:', details);
         }
           
            console.log(nickname, 'disconnected');
        })
    });

    // For each server forked, use its respective PORT
    const port = process.env.PORT;

    server.listen(3000, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
}