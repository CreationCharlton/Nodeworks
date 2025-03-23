// Configuration for the game
const config = {
    // Socket server URL - can be overridden by environment variable
    socketServerUrl: window.SOCKET_SERVER_URL || 'http://localhost:3001',
    
    // Game settings
    boardSize: 8,
    cellSize: 60,
    pieceSize: 50,
    
    // Colors
    colors: {
        white: '#FFFFFF',
        black: '#000000',
        boardLight: '#DEB887',
        boardDark: '#8B4513',
        highlight: 'rgba(255, 255, 0, 0.3)',
        validMove: 'rgba(0, 255, 0, 0.3)',
        lastMove: 'rgba(255, 165, 0, 0.3)',
        check: 'rgba(255, 0, 0, 0.3)',
        menuOverlay: 'rgba(0, 0, 0, 0.7)'
    },
    
    // Sound effects
    sounds: {
        move: '../Assets/click.mp3',
        capture: '../Assets/capture.mp3',
        check: '../Assets/check.mp3'
    },
    
    // Timeouts and delays
    timeouts: {
        aiMove: 1000,
        connectionRetry: 1000,
        maxConnectionAttempts: 5
    }
};

// Export the configuration
if (typeof module !== 'undefined' && module.exports) {
    module.exports = config;
} else {
    window.config = config;
} 