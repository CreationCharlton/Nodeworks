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
    origin: ['https://www.pr1me5.com', 'https://www.incomparable-mooncake-18764b.netlify.app/', 'http://localhost:3000'], 
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
            whiteGoldenPoints: 0,
            blackGoldenPoints: 0,
            currentOperation: null,
            lastMove: null,
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
        // Track the last move by comparing piece positions
        if (newState.board && newState.board.pieces) {
            const oldPositions = this.gameState.board.pieces.map(p => ({
                row: p.position.row,
                col: p.position.col
            }));
            
            const newPositions = newState.board.pieces.map(p => ({
                row: p.position.row,
                col: p.position.col
            }));

            // Find the piece that moved
            const movedPiece = newState.board.pieces.find(p => {
                const oldPos = oldPositions.find(op => 
                    p.value === this.gameState.board.pieces[oldPositions.indexOf(op)].value &&
                    p.isWhite === this.gameState.board.pieces[oldPositions.indexOf(op)].isWhite
                );
                return oldPos && (p.position.row !== oldPos.row || p.position.col !== oldPos.col);
            });

            if (movedPiece) {
                this.lastMove = {
                    piece: movedPiece,
                    from: oldPositions.find(op => 
                        !newPositions.some(np => np.row === op.row && np.col === op.col)
                    ),
                    to: {
                        row: movedPiece.position.row,
                        col: movedPiece.position.col
                    }
                };
            }
        }

        // Update game state
        this.gameState = {
            ...this.gameState,
            ...newState,
            lastMove: this.lastMove,
            isMultiplayer: true
        };

        this.broadcastGameState();
    }

    validateGameState(state) {
        if (!state || typeof state !== 'object') {
            return false;
        }

        if (!state.board || !Array.isArray(state.board.pieces)) {
            return false;
        }

        if (typeof state.whiteGoldenPoints !== 'number' || 
            typeof state.blackGoldenPoints !== 'number' || 
            typeof state.isWhiteTurn !== 'boolean') {
            return false;
        }

        if (state.vibratingPieces) {
            if (!Array.isArray(state.vibratingPieces)) return false;
            for (const vp of state.vibratingPieces) {
              if (typeof vp.row !== 'number' || 
                  typeof vp.col !== 'number' || 
                  typeof vp.timer !== 'number') return false;
            }
          }
          
          if (state.turnIndicatorVibration) {
            if (typeof state.turnIndicatorVibration.active !== 'boolean' ||
                typeof state.turnIndicatorVibration.progress !== 'number') return false;
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
            // Create new game state while preserving player information
            const preservedPlayers = new Map(this.players);
            
            // Create new initial game state
            const newGameState = {
                ...this.createInitialGameState(),
                status: 'playing',
                isMultiplayer: true,
                gameId: this.id,
                currentPlayers: this.getPlayerList()
            };

            // Update game state
            this.gameState = newGameState;
            this.players = preservedPlayers;
            this.isFinished = false;
            this.pendingRestarts.clear();

            // Notify all players about the restart with their specific state
            for (const [_, player] of this.players) {
                if (player.connected) {
                    player.socket.emit('game-restarted', {
                        message: 'Game has been restarted',
                        gameState: {
                            ...this.gameState,
                            playerColor: player.color,
                            playerName: player.name,
                            isMultiplayer: true
                        }
                    });
                }
            }

            // Broadcast the new state to all players
            this.broadcastGameState();
        } else {
            // Notify the other player that this player accepted
            this.notifyOpponent(socketId, 'restart-accepted', {
                accepter: accepter.name
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
        // Reset game state while preserving player information
        const preservedPlayers = new Map(this.players);
        
        // Create new initial game state with multiplayer flag
        const newGameState = {
            ...this.createInitialGameState(),
            status: 'playing',
            isMultiplayer: true,
            currentPlayers: this.getPlayerList()
        };

        // Update game state
        this.gameState = newGameState;
        this.players = preservedPlayers;
        this.isFinished = false;
        this.pendingRestarts.clear();

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
                        currentPlayers: this.getPlayerList()
                    }
                });
            }
        }

        // Broadcast the new state
        this.broadcastGameState();
    }

    handleGameUpdate(socket, newState) {
        const player = this.players.get(socket.id);
        if (!player) {
            console.log(`Update rejected: Player not found in game ${this.id}`);
            return false;
        }

        // Check for game end conditions
        if (newState.gameOver) {
            this.isFinished = true;
            this.gameState.status = 'finished';
            this.gameState.winner = newState.winner;

            // Notify all players about the game end
            for (const [_, p] of this.players) {
                if (p.connected) {
                    p.socket.emit('game-over', {
                        winner: newState.winner,
                        message: `${newState.winner} has won the game!`
                    });
                }
            }

            // Set a timeout for cleanup if no restart is requested
            setTimeout(() => {
                if (!this.pendingRestarts.size && this.isFinished) {
                    this.cleanup();
                }
            }, 180000); // 3 minutes timeout
            
            return true;
        }

        // Rest of your existing validation logic...
        if (!this.validateGameState(newState)) {
            console.log(`Update rejected: Invalid game state in game ${this.id}`);
            return false;
        }

        this.updateGameState(newState);
        return true;
    }

    broadcastGameState() {
        const stateToSend = {
            ...this.gameState,
            currentPlayers: this.getPlayerList()
        };

        for (const [_, player] of this.players) {
            if (player.connected) {
                player.socket.emit('game-state', stateToSend);
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
        this.gameState.status = 'finished';
        
        // Notify all players about the forfeit
        for (const [_, p] of this.players) {
            if (p.connected) {
                p.socket.emit('game-forfeited', {
                    forfeitingPlayer: player.name,
                    forfeitingColor: player.color,
                    message: `${player.name} has forfeited the game!`
                });
            }
        }

        // Cleanup after a short delay
        setTimeout(() => {
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
        for (const [_, player] of this.players) {
            if (player.connected) {
                player.socket.disconnect(true);
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
