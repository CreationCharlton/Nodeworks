// server.js
const express = require('express');
const http = require('http');
const io = require('socket.io');
const cors = require('cors');
const path = require('path');

// Initialize Express app and middleware
const app = express();
app.use(cors({
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'Public')));
app.use('/Assets', express.static(path.join(__dirname, 'Assets')));

// Create HTTP server and Socket.IO instance
const server = http.createServer(app);
const ioInstance = io(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  path: '/socket.io/',
  transports: ['websocket', 'polling']
});

const corsOptions = {
    origin: ['https://www.pr1me5.com', 'https://www.incomparable-mooncake-18764b.netlify.app/', 'http://localhost:3000'], 
    methods: ["GET", "POST"],
    credentials: true
};
  
app.use(cors(corsOptions));
app.get("/", (req, res) => res.send("Server is live!"));

// Serve Socket.IO client files
app.use('/socket.io', express.static(path.join(__dirname, 'node_modules/socket.io/client-dist')));

// Store active players and their game states
const activePlayers = new Map();
const gameStates = new Map();
const gameRooms = new Map();

ioInstance.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Handle player registration
    socket.on('registerPlayer', (username) => {
        activePlayers.set(socket.id, {
            username,
            socketId: socket.id,
            inGame: false
        });
        
        // Broadcast updated player list to all clients
        ioInstance.emit('activePlayers', Array.from(activePlayers.values()));
    });

    // Handle game creation
    socket.on('create-game', (playerName) => {
        const gameId = `game_${Date.now()}`;
        gameRooms.set(gameId, {
            host: socket.id,
            players: [{
                id: socket.id,
                name: playerName,
                color: 'white'
            }],
            status: 'waiting'
        });
        
        socket.join(gameId);
        socket.emit('game-created', { gameId });
    });

    // Handle game joining
    socket.on('join-game', ({ gameId, playerName }) => {
        const game = gameRooms.get(gameId);
        if (game && game.status === 'waiting') {
            game.players.push({
                id: socket.id,
                name: playerName,
                color: 'black'
            });
            game.status = 'playing';
            
            socket.join(gameId);
            
            // Notify both players
            ioInstance.to(gameId).emit('player-joined', {
                players: game.players,
                gameState: gameStates.get(gameId)
            });
        }
    });

    // Handle game state updates
    socket.on('gameState', (data) => {
        const { gameId, state } = data;
        gameStates.set(gameId, state);
        socket.to(gameId).emit('gameState', state);
    });

    // Handle player disconnection
    socket.on('player-disconnected', ({ gameId, playerColor, playerName }) => {
        const game = gameRooms.get(gameId);
        if (game) {
            ioInstance.to(gameId).emit('opponent-disconnected', {
                playerColor,
                playerName
            });
            
            // Clean up game room
            gameRooms.delete(gameId);
            gameStates.delete(gameId);
        }
    });

    // Handle game restart requests
    socket.on('request-restart', ({ gameId, requester, playerColor }) => {
        socket.to(gameId).emit('restart-request', {
            gameId,
            requester,
            playerColor
        });
    });

    // Handle restart acceptance
    socket.on('restart-accepted', ({ gameId, accepter, playerColor }) => {
        const game = gameRooms.get(gameId);
        if (game) {
            // Reset game state
            const newGameState = {
                ...gameStates.get(gameId),
                board: null, // Reset board
                currentTurn: 'white',
                status: 'playing'
            };
            
            gameStates.set(gameId, newGameState);
            
            // Notify both players
            ioInstance.to(gameId).emit('game-restarted', {
                gameState: newGameState
            });
        }
    });

    // Handle restart rejection
    socket.on('restart-rejected', ({ gameId, rejecter }) => {
        socket.to(gameId).emit('restart-rejected', {
            gameId,
            rejecter
        });
    });

    // Handle restart cancellation
    socket.on('restart-cancelled', ({ gameId, playerName }) => {
        socket.to(gameId).emit('restart-cancelled', {
            gameId,
            playerName
        });
    });

    // Handle player challenge
    socket.on('challengePlayer', ({ targetId }) => {
        const challenger = activePlayers.get(socket.id);
        const target = activePlayers.get(targetId);
        
        if (challenger && target && !target.inGame) {
            ioInstance.to(targetId).emit('challengeReceived', {
                challengerId: socket.id,
                challengerName: challenger.username
            });
        }
    });

    // Handle challenge response
    socket.on('challengeResponse', ({ challengerId, accepted }) => {
        if (accepted) {
            const gameId = `game_${Date.now()}`;
            const challenger = activePlayers.get(challengerId);
            const responder = activePlayers.get(socket.id);
            
            // Update player status
            activePlayers.get(challengerId).inGame = true;
            activePlayers.get(socket.id).inGame = true;
            
            // Notify both players
            ioInstance.to(challengerId).emit('gameStarted', { gameId, opponent: responder.username });
            ioInstance.to(socket.id).emit('gameStarted', { gameId, opponent: challenger.username });
            
            // Broadcast updated player list
            ioInstance.emit('activePlayers', Array.from(activePlayers.values()));
        } else {
            ioInstance.to(challengerId).emit('challengeDeclined', { playerId: socket.id });
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        const player = activePlayers.get(socket.id);
        if (player) {
            activePlayers.delete(socket.id);
            ioInstance.emit('activePlayers', Array.from(activePlayers.values()));
        }
        console.log('User disconnected:', socket.id);
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
