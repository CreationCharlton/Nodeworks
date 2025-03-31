// server.js
const games = new Map();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
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
const io = new Server(server, {
  cors: {
    origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    path: '/socket.io/',
    transports: ['websocket', 'polling']
});

const corsOptions = {
    origin: ['https://www.incomparable-mooncake-18764b.netlify.app/', 'http://localhost:3000'], 
    methods: ["GET", "POST"],
    credentials: true
  };
  
  app.use(cors(corsOptions));

  app.get("/", (req, res) => res.send("Server is live!"));


// Serve Socket.IO client files
app.use('/socket.io', express.static(path.join(__dirname, 'node_modules/socket.io/client-dist')));

// Game state management
class GameRoom {
    constructor(id) {
        this.id = id;
        this.players = new Map();
        this.gameState = this.createInitialGameState();
        this.isFinished = false;
        this.lastActivityTime = Date.now();
        this.inactivityTimeout = 30 * 60 * 1000; // 30 minutes
        console.log(`Created new game room: ${id}`);
        this.pendingRestarts = new Set();
    }

    createInitialGameState() {
        return {
            board: {
                pieces: []
            },
            isWhiteTurn: true,
            status: 'waiting',
            whiteGoldenStorage: [],
            blackGoldenStorage: [],
            currentPlayers: []
        };
    }

    addPlayer(socket, playerName) {
        // Remove existing player with same name if any
        for (const [existingId, player] of this.players.entries()) {
            if (player.name === playerName) {
                console.log(`Removing existing player ${playerName} from game ${this.id}`);
                this.players.delete(existingId);
                break;
            }
        }

        const isFirstPlayer = this.players.size === 0;
        const playerColor = isFirstPlayer ? 'white' : 'black';

        this.players.set(socket.id, {
            socket,
            name: playerName,
            color: playerColor,
            connected: true,
            joinTime: Date.now()
        });

        this.updateGameState({
            status: this.players.size === 2 ? 'playing' : 'waiting',
            currentPlayers: this.getPlayerList()
        });

        console.log(`Added player ${playerName} as ${playerColor} to game ${this.id}`);
        return playerColor;
    }

    getPlayerList() {
        return Array.from(this.players.values())
            .filter(p => p.connected)
            .map(p => ({
                name: p.name,
                color: p.color
            }));
    }

    updateGameState(newState) {
        try {
            // Check if this is a restart update
            if (newState.isRestart) {
                this.restartGame();
                return;
            }

            // Save player information before update
            const preservedPlayers = new Map(this.players);
            
            // Update game state
            this.gameState = {
                ...this.gameState,
                ...newState,
                board: newState.board,
                isWhiteTurn: newState.isWhiteTurn,
                whiteGoldenStorage: newState.whiteGoldenStorage,
                blackGoldenStorage: newState.blackGoldenStorage,
                currentOperation: newState.currentOperation,
                lastMove: newState.lastMove, // Add this to track last move
                isMultiplayer: true // Always preserve multiplayer flag
            };

            // Restore player information
            this.players = preservedPlayers;
            
            // Update last activity time
            this.lastActivityTime = Date.now();

            // Broadcast the updated state to all players
            this.broadcastGameState();

            // Log the update for debugging
            console.log('Game state updated:', {
                gameId: this.id,
                playersCount: this.players.size,
                lastMove: this.gameState.lastMove,
                isWhiteTurn: this.gameState.isWhiteTurn
            });
        } catch (error) {
            console.error('Error updating game state:', error);
        }
    }

    validateGameState(state) {
        if (!state || typeof state !== 'object') {
            return false;
        }

        if (!state.board || !Array.isArray(state.board.pieces)) {
            return false;
        }

        // Validate each piece has required properties
        for (const piece of state.board.pieces) {
            if (!piece.hasOwnProperty('value') || 
                !piece.hasOwnProperty('isWhite') || 
                !piece.hasOwnProperty('position')) {
                return false;
            }
        }

        return true;
    }

    handleRestartRequest(socketId) {
        const requester = this.players.get(socketId);
        if (!requester) return;

        // Add the requester to pending restarts
        this.pendingRestarts.add(socketId);
        
        // Notify the opponent about the restart request
        this.notifyOpponent(socketId, 'restart-request', {
            requester: requester.name,
            playerColor: requester.color
        });
    }

    handleRestartAccept(socketId) {
        const accepter = this.players.get(socketId);
        if (!accepter) return;

        this.pendingRestarts.add(socketId);

        // If both players have accepted, restart the game
        if (this.pendingRestarts.size === 2) {
            // Send a special update to trigger restart
            this.updateGameState({ isRestart: true });
        } else {
            // Notify the other player that this player accepted
            this.notifyOpponent(socketId, 'restart-accepted', {
                accepter: accepter.name,
                playerColor: accepter.color
            });
        }
    }

    handleRestartReject(socketId) {
        const rejecter = this.players.get(socketId);
        if (!rejecter) return;

        // Clear pending restarts
        this.pendingRestarts.clear();

        // Notify the other player about the rejection
        this.notifyOpponent(socketId, 'restart-rejected', {
            rejecter: rejecter.name
        });
    }

    restartGame() {
        try {
            // Preserve the current players and their information
            const preservedPlayers = new Map(this.players);
            
            // Create new initial game state
            const newGameState = {
                ...this.createInitialGameState(),
                status: 'playing',
                isMultiplayer: true,
                currentPlayers: this.getPlayerList(),
                gameId: this.id // Keep the same game ID
            };

            // Update game state while preserving player connections
            this.gameState = newGameState;
            this.players = preservedPlayers;
            this.isFinished = false;
            this.pendingRestarts.clear();
            this.lastActivityTime = Date.now();

            // Notify all players about the restart
            for (const [_, player] of this.players) {
                if (player.connected) {
                    player.socket.emit('game-restarted', {
                        message: 'Game has been restarted',
                        gameState: {
                            ...this.gameState,
                            isMultiplayer: true,
                            playerColor: player.color,
                            playerName: player.name,
                            currentPlayers: this.getPlayerList(),
                            gameId: this.id
                        }
                    });
                }
            }

            // Broadcast the new state to ensure synchronization
            this.broadcastGameState();
            
            console.log(`Game ${this.id} restarted with preserved player sessions`);
        } catch (error) {
            console.error('Error restarting game:', error);
        }
    }

    handleGameUpdate(socket, newState) {
        const player = this.players.get(socket.id);
        if (!player) {
            console.log(`Update rejected: Player not found in game ${this.id}`);
            return false;
        }

        if (!this.validateGameState(newState)) {
            console.log(`Update rejected: Invalid game state in game ${this.id}`);
            return false;
        }

        // Check for win condition
        if (newState.winner) {
            this.handleWin(player, newState.winner);
            return true;
        }

        const isCorrectTurn = (this.gameState.isWhiteTurn && player.color === 'white') ||
                            (!this.gameState.isWhiteTurn && player.color === 'black');

        if (!isCorrectTurn) {
            console.log(`Update rejected: Not player's turn in game ${this.id}`);
            return false;
        }

        this.updateGameState(newState);
        return true;
    }

    handleWin(player, winner) {
        this.isFinished = true;
        
        // Notify all players about the win
        for (const [_, p] of this.players) {
            if (p.connected) {
                p.socket.emit('game-won', {
                    winner: winner,
                    winnerName: player.name,
                    message: `${player.name} has won the game!`
                });
            }
        }

        // Set a timeout to return to menu
        setTimeout(() => {
            for (const [_, p] of this.players) {
                if (p.connected) {
                    p.socket.emit('return-to-menu');
                }
            }
        }, 10000); // 10 seconds delay before returning to menu
    }

    broadcastGameState() {
        const stateToSend = {
            ...this.gameState,
            currentPlayers: this.getPlayerList(),
            lastMove: this.gameState.lastMove // Ensure last move is included
        };

        for (const [_, player] of this.players) {
            if (player.connected) {
                player.socket.emit('game-state', {
                    ...stateToSend,
                    playerColor: player.color, // Include player-specific information
                    playerName: player.name
                });
            }
        }
    }

    handleDisconnect(socketId) {
        const player = this.players.get(socketId);
        if (!player) return null;

        player.connected = false;
        player.disconnectTime = Date.now();

        // Update game status
        this.updateGameState({
            status: 'waiting',
            currentPlayers: this.getPlayerList()
        });

        // Notify other player
        this.notifyOpponent(socketId, 'opponent-disconnected', {
            message: `${player.name} has disconnected from the game.`
        });

        // Check if game should be marked as finished
        if (this.getPlayerList().length === 0) {
            this.isFinished = true;
        }

        return player;
    }

    handleForfeit(socketId) {
        const player = this.players.get(socketId);
        if (!player) return;

        this.isFinished = true;
        
        // Notify all players about the forfeit
        for (const [_, p] of this.players) {
            if (p.connected) {
                if (p.socket.id === socketId) {
                    // Forfeiting player
                    p.socket.emit('game-forfeited', {
                        message: 'You forfeited the game'
                    });
                } else {
                    // Opponent
                    p.socket.emit('opponent-forfeit', {
                        playerName: player.name,
                        playerColor: player.color,
                        message: `${player.name} has forfeited the game`
                    });
                }
            }
        }

        // Return both players to menu after a short delay
        setTimeout(() => {
            for (const [_, p] of this.players) {
                if (p.connected) {
                    p.socket.emit('return-to-menu');
                }
            }
            this.cleanup();
        }, 3000);
    }

    notifyOpponent(socketId, event, data) {
        for (const [id, player] of this.players) {
            if (id !== socketId && player.connected) {
                player.socket.emit(event, data);
            }
        }
    }

    isStale() {
        return Date.now() - this.lastActivityTime > this.inactivityTimeout;
    }

    cleanup() {
        // Notify all players before cleanup
        for (const [_, player] of this.players) {
            if (player.connected) {
                player.socket.emit('return-to-menu');
                player.socket.leave(this.id); // Leave the room
            }
        }
        this.players.clear();
        this.isFinished = true;
    }
}

// Game rooms management
const gameRooms = new Map();

function generateGameId() {
    const id = Math.random().toString(36).substring(2, 7).toUpperCase();
    return gameRooms.has(id) ? generateGameId() : id;
}

function cleanupStaleGames() {
    for (const [gameId, gameRoom] of gameRooms.entries()) {
        if (gameRoom.isFinished || gameRoom.isStale()) {
            console.log(`Cleaning up game room ${gameId}`);
            gameRoom.cleanup();
            gameRooms.delete(gameId);
        }
    }
}

// Socket.IO event handlers
io.on('connection', (socket) => {
    console.log(`New client connected: ${socket.id}`);

    socket.on('create-game', (playerName) => {
        try {
            if (!playerName || typeof playerName !== 'string' || playerName.length < 1) {
                socket.emit('error', { message: 'Invalid player name' });
                return;
            }

            const gameId = generateGameId();
            const gameRoom = new GameRoom(gameId);
            const playerColor = gameRoom.addPlayer(socket, playerName);
            
            gameRooms.set(gameId, gameRoom);
            socket.join(gameId);

            socket.emit('game-created', {
                gameId,
                playerColor,
                gameState: gameRoom.gameState
            });

            console.log(`Created game ${gameId} for player ${playerName}`);
        } catch (error) {
            console.error('Error creating game:', error);
            socket.emit('error', { message: 'Failed to create game' });
        }
    });

    socket.on('join-game', ({ gameId, playerName }) => {
        try {
            if (!gameId || !playerName) {
                socket.emit('join-error', 'Invalid game ID or player name');
                return;
            }

            const cleanGameId = gameId.trim().toUpperCase();
            const gameRoom = gameRooms.get(cleanGameId);

            if (!gameRoom) {
                socket.emit('join-error', 'Game not found');
                return;
            }

            if (gameRoom.isFinished) {
                socket.emit('join-error', 'Game is already finished');
                return;
            }

            if (gameRoom.getPlayerList().length >= 2) {
                socket.emit('join-error', 'Game is full');
                return;
            }

            const playerColor = gameRoom.addPlayer(socket, playerName);
            socket.join(cleanGameId);

            socket.emit('game-joined', {
                gameId: cleanGameId,
                playerColor,
                gameState: gameRoom.gameState
            });

            // Notify all players
            io.to(cleanGameId).emit('player-joined', {
                gameId: cleanGameId,
                players: gameRoom.getPlayerList(),
                gameState: gameRoom.gameState
            });

            console.log(`Player ${playerName} joined game ${cleanGameId}`);
        } catch (error) {
            console.error('Error joining game:', error);
            socket.emit('join-error', 'Failed to join game');
        }
    });

    socket.on('game-update', ({ gameId, gameState }) => {
        try {
            if (!gameId) {
                console.log('Game update rejected: No game ID provided');
                return;
            }

            const gameRoom = gameRooms.get(gameId);
            if (!gameRoom) {
                console.log(`Game update rejected: Game ${gameId} not found`);
                return;
            }

            if (gameRoom.handleGameUpdate(socket, gameState)) {
                console.log(`Game ${gameId} state updated successfully`);
            }
        } catch (error) {
            console.error('Error updating game state:', error);
        }
    });

    socket.on('player-forfeit', ({ gameId }) => {
        try {
            const gameRoom = gameRooms.get(gameId);
            if (gameRoom) {
                gameRoom.handleForfeit(socket.id);
                console.log(`Player forfeited game ${gameId}`);
            }
        } catch (error) {
            console.error('Error handling forfeit:', error);
    }
  });

    // Handle restart request
    socket.on('request-restart', (data) => {
        try {
            const { gameId } = data;
            const gameRoom = gameRooms.get(gameId);
            
            if (gameRoom) {
                gameRoom.handleRestartRequest(socket.id);
            }
        } catch (error) {
            console.error('Error handling restart request:', error);
        }
    });

    // Handle restart acceptance
    socket.on('restart-accepted', (data) => {
        try {
            const { gameId } = data;
            const gameRoom = gameRooms.get(gameId);
            
            if (gameRoom) {
                gameRoom.handleRestartAccept(socket.id);
            }
        } catch (error) {
            console.error('Error handling restart acceptance:', error);
        }
    });

    // Handle restart rejection
    socket.on('restart-rejected', (data) => {
        try {
            const { gameId } = data;
            const gameRoom = gameRooms.get(gameId);
            
            if (gameRoom) {
                gameRoom.handleRestartReject(socket.id);
            }
        } catch (error) {
            console.error('Error handling restart rejection:', error);
        }
    });

    // Handle restart cancellation
    socket.on('restart-cancelled', (data) => {
        try {
            const { gameId, playerName } = data;
            const game = games.get(gameId);
            
            if (game) {
                // Find opponent's socket
                const opponentSocket = Array.from(game.players).find(
                    player => player.socket.id !== socket.id
                );

                if (opponentSocket) {
                    // Notify opponent that restart request was cancelled
                    opponentSocket.socket.emit('restart-cancelled', {
                        playerName
                    });
                }
            }
        } catch (error) {
            console.error('Error handling restart cancellation:', error);
        }
    });

    socket.on('game-won', ({ gameId, winner }) => {
        try {
            const gameRoom = gameRooms.get(gameId);
            if (gameRoom) {
                gameRoom.handleWin(gameRoom.players.get(socket.id), winner);
            }
        } catch (error) {
            console.error('Error handling game win:', error);
        }
    });

  socket.on('disconnect', () => {
        try {
            console.log(`Client disconnected: ${socket.id}`);
            
            for (const [gameId, gameRoom] of gameRooms.entries()) {
                const disconnectedPlayer = gameRoom.handleDisconnect(socket.id);
                if (disconnectedPlayer) {
                    console.log(`Player ${disconnectedPlayer.name} disconnected from game ${gameId}`);
                    
                    if (gameRoom.isFinished) {
                        console.log(`Removing finished game ${gameId}`);
                        gameRooms.delete(gameId);
                    }
                    break;
                }
            }
        } catch (error) {
            console.error('Error handling disconnect:', error);
        }
  });
});

// Cleanup interval
setInterval(cleanupStaleGames, 5 * 60 * 1000); // Every 5 minutes

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
