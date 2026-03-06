/* app.js â€” Main app logic, routing, API client */

// API base â€” same origin, Flask serves both frontend and API
const API_BASE = '/api';

// ============================================================================
// State
// ============================================================================
let authToken = null;
let currentUser = null;
let pollingInterval = null;
let currentScreen = null;
let isAiGame = false;  // Track if current game is vs AI

// Auto-start timer (managed in game-engine.js, cleared here)
let autoStartTimer = null;
let autoStartTimerRunning = false;
let autoStartCountdown = 10;

function clearAutoStartTimer() {
    if (autoStartTimer) {
        clearInterval(autoStartTimer);
        autoStartTimer = null;
    }
    autoStartTimerRunning = false;
    autoStartCountdown = 10;
}

// ============================================================================
// API Client
// ============================================================================
async function api(method, path, body = null) {
    const opts = {
        method,
        headers: {}
    };
    let url = `${API_BASE}${path}`;
    if (authToken) {
        opts.headers['Authorization'] = `Bearer ${authToken}`;
        // Also send as query param as fallback
        const sep = url.includes('?') ? '&' : '?';
        url += `${sep}token=${encodeURIComponent(authToken)}`;
    }
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    try {
        const res = await fetch(url, opts);
        let data;
        try {
            data = await res.json();
        } catch (parseErr) {
            throw new Error(`Server error (${res.status})`);
        }
        if (!res.ok) {
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        return data;
    } catch (e) {
        if (e.message && e.message.includes('Unauthorized')) {
            authToken = null;
            currentUser = null;
            navigate('login');
        }
        throw e;
    }
}

// ============================================================================
// Toast Notifications
// ============================================================================
function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
}

// ============================================================================
// Router
// ============================================================================
function navigate(screen) {
    stopPolling();
    clearAutoStartTimer();
    // Always close scoring overlay and chat when navigating away from game
    if (currentScreen === 'game' && screen !== 'game') {
        closeScoringOverlay();
        stopChatPolling();
        setChatOpen(false);
    }
    currentScreen = screen;
    window.location.hash = screen;

    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(`screen-${screen}`);
    if (el) el.classList.add('active');

    switch (screen) {
        case 'login': initLoginScreen(); break;
        case 'lobby': initLobbyScreen(); break;
        case 'room': initRoomScreen(); break;
        case 'game': initGameScreen(); break;
    }
}

function initRouter() {
    window.addEventListener('hashchange', () => {
        const hash = window.location.hash.replace('#', '') || 'login';
        if (hash !== currentScreen) navigate(hash);
    });
    const initial = window.location.hash.replace('#', '') || 'login';
    navigate(initial);
}

// Fallback: also init on window load
window.addEventListener('load', () => {
    if (!currentScreen) {
        initRouter();
    }
});

// ============================================================================
// Polling
// ============================================================================
function stopPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
}

function startPolling(fn, interval) {
    stopPolling();
    fn(); // immediate first call
    pollingInterval = setInterval(fn, interval);
}

// ============================================================================
// Login Screen
// ============================================================================
function initLoginScreen() {
    if (authToken) {
        navigate('lobby');
        return;
    }

    const form = document.getElementById('login-form');
    const errorEl = document.getElementById('login-error');
    const tabs = document.querySelectorAll('.login-tab');
    let isRegister = false;

    tabs.forEach(tab => {
        tab.onclick = () => {
            isRegister = tab.dataset.tab === 'register';
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('login-submit-btn').textContent = isRegister ? 'Create Account' : 'Sign In';
            errorEl.textContent = '';
        };
    });

    form.onsubmit = async (e) => {
        e.preventDefault();
        errorEl.textContent = '';
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value;

        if (!username || !password) {
            errorEl.textContent = 'Please fill in all fields';
            return;
        }

        try {
            const endpoint = isRegister ? '/register' : '/login';
            const data = await api('POST', endpoint, { username, password });
            authToken = data.token;
            currentUser = { id: data.user_id, username: data.username };
            navigate('lobby');
        } catch (err) {
            errorEl.textContent = err.message;
        }
    };
}

// ============================================================================
// Lobby Screen
// ============================================================================
function initLobbyScreen() {
    if (!authToken) { navigate('login'); return; }

    loadUserInfo();
    loadRoomList();
    loadLeaderboard();
    startPolling(() => { loadRoomList(); loadLeaderboard(); }, 3000);

    document.getElementById('create-room-btn').onclick = () => {
        document.getElementById('create-room-modal').classList.add('active');
    };

    document.getElementById('cancel-create-room').onclick = () => {
        document.getElementById('create-room-modal').classList.remove('active');
    };

    document.getElementById('create-room-form').onsubmit = async (e) => {
        e.preventDefault();
        const pv = parseFloat(document.getElementById('room-point-value').value) || 1;
        const mp = parseInt(document.getElementById('room-max-players').value) || 4;
        try {
            await api('POST', '/rooms', { point_value: pv, max_players: mp });
            document.getElementById('create-room-modal').classList.remove('active');
            navigate('room');
        } catch (err) {
            showToast(err.message, 'error');
        }
    };

    document.getElementById('join-code-btn').onclick = async () => {
        const code = document.getElementById('join-code-input').value.trim().toUpperCase();
        if (!code) return;
        try {
            await api('POST', '/rooms/join', { room_code: code });
            navigate('room');
        } catch (err) {
            showToast(err.message, 'error');
        }
    };

    // Settings gear button opens settings modal
    document.getElementById('settings-btn').onclick = () => openSettings();

    // Play AI button
    document.getElementById('play-ai-btn').onclick = async () => {
        const btn = document.getElementById('play-ai-btn');
        btn.disabled = true;
        btn.textContent = 'Starting...';
        try {
            await api('POST', '/play-ai');
            isAiGame = true;
            navigate('game');
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Play AI';
        }
    };
}

async function loadUserInfo() {
    try {
        const data = await api('GET', '/me');
        currentUser = { id: data.user_id, username: data.username };
        document.getElementById('header-username').textContent = data.username;
        document.getElementById('header-points').textContent = `${data.net_points >= 0 ? '+' : ''}${data.net_points} pts`;
        const ptsEl = document.getElementById('header-points');
        ptsEl.classList.remove('pts-positive', 'pts-negative', 'pts-zero');
        if (data.net_points > 0) ptsEl.classList.add('pts-positive');
        else if (data.net_points < 0) ptsEl.classList.add('pts-negative');
        else ptsEl.classList.add('pts-zero');
    } catch (err) {
        // ignore
    }
}

async function loadRoomList() {
    if (currentScreen !== 'lobby') return;
    try {
        const rooms = await api('GET', '/rooms');
        const list = document.getElementById('room-list');
        if (rooms.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <div class="icon">â™ </div>
                    <p>No open rooms. Create one!</p>
                </div>`;
            return;
        }
        list.innerHTML = rooms.map(r => `
            <div class="room-item">
                <div class="room-info">
                    <span class="room-code">${r.room_code}</span>
                    <span class="room-meta">
                        <span>Host: ${escapeHtml(r.host)}</span>
                        <span>${r.player_count}/${r.max_players} players</span>
                        <span>${r.point_value}x pts</span>
                    </span>
                </div>
                <button class="btn btn-primary btn-sm" onclick="joinRoom('${r.room_code}')">Join</button>
            </div>
        `).join('');
    } catch (err) {
        // ignore polling errors
    }
}

async function joinRoom(code) {
    try {
        await api('POST', '/rooms/join', { room_code: code });
        navigate('room');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function loadLeaderboard() {
    if (currentScreen !== 'lobby') return;
    try {
        const data = await api('GET', '/leaderboard');
        const el = document.getElementById('leaderboard');
        if (data.length === 0) {
            el.innerHTML = `
                <div class="empty-state">
                    <div class="icon">\u265B</div>
                    <p>No games played yet</p>
                </div>`;
            return;
        }
        el.innerHTML = `
            <div class="lb-header">
                <span class="lb-rank">#</span>
                <span class="lb-name">Player</span>
                <span class="lb-stat">W</span>
                <span class="lb-stat">L</span>
                <span class="lb-net">Net</span>
            </div>
            ${data.map(p => {
                const netClass = p.net_points > 0 ? 'pts-positive' : p.net_points < 0 ? 'pts-negative' : 'pts-zero';
                const netText = p.net_points > 0 ? `+${p.net_points}` : `${p.net_points}`;
                const isSelf = currentUser && p.username === currentUser.username;
                const selfClass = isSelf ? 'lb-self' : '';
                return `
                    <div class="lb-row ${selfClass}">
                        <span class="lb-rank">${p.rank}</span>
                        <span class="lb-name">${escapeHtml(p.username)}</span>
                        <span class="lb-stat">${p.points_won}</span>
                        <span class="lb-stat">${p.points_lost}</span>
                        <span class="lb-net ${netClass}">${netText}</span>
                    </div>`;
            }).join('')}`;
    } catch (err) {
        // ignore polling errors
    }
}

// ============================================================================
// Room Screen
// ============================================================================
function initRoomScreen() {
    if (!authToken) { navigate('login'); return; }

    loadRoomState();
    startPolling(loadRoomState, 2000);

    document.getElementById('ready-btn').onclick = async () => {
        try {
            await api('POST', '/rooms/ready');
        } catch (err) {
            showToast(err.message, 'error');
        }
    };

    document.getElementById('leave-room-btn').onclick = async () => {
        try {
            await api('POST', '/rooms/leave');
            navigate('lobby');
        } catch (err) {
            showToast(err.message, 'error');
        }
    };
}

async function loadRoomState() {
    if (currentScreen !== 'room') return;
    try {
        const state = await api('GET', '/room-state');

        if (state.status === 'in_progress') {
            navigate('game');
            return;
        }

        document.getElementById('room-code-text').textContent = state.room_code;
        document.getElementById('room-point-display').textContent = `${state.point_value}x points`;

        const slotsEl = document.getElementById('player-slots');
        let html = '';
        for (let i = 0; i < state.max_players; i++) {
            const player = state.players[i];
            if (player) {
                const readyClass = player.is_ready ? 'ready' : '';
                const badgeClass = player.is_ready ? 'is-ready' : 'not-ready';
                const badgeText = player.is_ready ? 'Ready' : 'Not Ready';
                const hostBadge = player.is_host ? ' (Host)' : '';
                html += `
                    <div class="player-slot ${readyClass}">
                        <div class="player-name">${escapeHtml(player.username)}${hostBadge}</div>
                        <span class="ready-badge ${badgeClass}">${badgeText}</span>
                    </div>`;
            } else {
                html += `<div class="player-slot empty"><div class="player-name">Empty Seat</div></div>`;
            }
        }
        slotsEl.innerHTML = html;

        // Update ready button text
        const myPlayer = state.players.find(p => p.user_id === currentUser.id);
        const readyBtn = document.getElementById('ready-btn');
        if (myPlayer) {
            readyBtn.textContent = myPlayer.is_ready ? 'Not Ready' : 'Ready Up';
            readyBtn.className = myPlayer.is_ready ? 'btn btn-secondary' : 'btn btn-primary';
        }
    } catch (err) {
        if (err.message.includes('Not in a room')) {
            navigate('lobby');
        }
    }
}

// Copy room code on click
document.addEventListener('click', (e) => {
    if (e.target.closest('.room-code-display')) {
        const code = document.getElementById('room-code-text').textContent;
        if (navigator.clipboard) {
            navigator.clipboard.writeText(code).then(() => showToast('Room code copied!', 'success'));
        }
    }
});

// ============================================================================
// Game Screen  
// ============================================================================
let gameState = null;
let lastHandNumber = null; // track hand number to detect new hands
let actionPhase = null; // null, 'drawn', 'select_replace', 'select_reveal'
let drawnCard = null;
let animatingReveal = false;
let actionInFlight = false; // Prevent double-clicks and race conditions
let autoDrawInProgress = false;  // prevents double auto-draw
let autoDrawDoneForTurn = false; // tracks if we already auto-drew this turn
let autoDrawRetryCount = 0;  // track auto-draw retries to prevent infinite loops
let showDrawAnimation = false;   // controls the fly-in animation
let drawAnimationCard = null;    // card data for animation

function initGameScreen() {
    if (!authToken) { navigate('login'); return; }
    clearAutoStartTimer();
    actionPhase = null;
    drawnCard = null;
    gameState = null;
    lastHandNumber = null;
    animatingReveal = false;
    actionInFlight = false;
    autoDrawInProgress = false;
    autoDrawDoneForTurn = false;
    autoDrawRetryCount = 0;
    showDrawAnimation = false;
    drawAnimationCard = null;
    // Only init chat for non-AI games
    if (!isAiGame) {
        initChat();
    } else {
        stopChatPolling();
        setChatOpen(false);
    }
    // Hide/show chat toggle button based on game type
    const chatBtn = document.getElementById('chat-toggle-btn');
    if (chatBtn) chatBtn.style.display = isAiGame ? 'none' : '';
    loadGameState();
    startPolling(loadGameState, 1500);
}

async function loadGameState() {
    if (currentScreen !== 'game') return;
    // Don't overwrite state while an action is in flight
    if (actionInFlight) return;
    // Don't poll while user is actively selecting a card to replace/reveal
    // (poll re-renders would destroy the selection UI mid-click)
    if (actionPhase === 'select_replace' || actionPhase === 'select_reveal') return;
    try {
        const state = await api('GET', '/game-state');
        // Check if game ended due to not enough players
        if (state && state.game_over_reason === 'not_enough_players') {
            stopPolling();
            closeScoringOverlay();
            isAiGame = false;
            showToast('Not enough players â€” game ended', 'info');
            setTimeout(() => navigate('lobby'), 2500);
            return;
        }
        // Sync AI game flag from server and update chat visibility
        if (state && state.is_ai_game !== undefined) {
            isAiGame = state.is_ai_game;
            const chatBtn = document.getElementById('chat-toggle-btn');
            if (chatBtn) chatBtn.style.display = isAiGame ? 'none' : '';
        }
        gameState = state;
        renderGame(state);
    } catch (err) {
        if (err.message.includes('Not in an active game')) {
            closeScoringOverlay();
            isAiGame = false;
            navigate('lobby');
        }
    }
}

function renderGame(state) {
    if (typeof renderGameTable === 'function') {
        // Sync AI game state from server
        if (state && state.is_ai_game !== undefined) {
            isAiGame = state.is_ai_game;
        }

        // Detect new hand â€” reset all draw/action state
        if (state && state.hand_number !== lastHandNumber) {
            if (lastHandNumber !== null) {
                // Hand changed â€” full reset
                actionPhase = null;
                drawnCard = null;
                actionInFlight = false;
                autoDrawInProgress = false;
                autoDrawDoneForTurn = false;
                autoDrawRetryCount = 0;
                showDrawAnimation = false;
                drawAnimationCard = null;
                animatingReveal = false;
            }
            lastHandNumber = state.hand_number;
        }

        // Restore drawn card state from server if we have a pending card
        if (state && state.pending_drawn_card && state.is_my_turn) {
            drawnCard = state.pending_drawn_card;
            if (actionPhase === null) {
                actionPhase = 'drawn';
            }
            autoDrawDoneForTurn = true; // already have a card
        } else if (state && !state.is_my_turn) {
            // Not our turn â€” reset action state
            actionPhase = null;
            drawnCard = null;
            autoDrawDoneForTurn = false;
            autoDrawInProgress = false;
            showDrawAnimation = false;
            drawAnimationCard = null;
        }
        
        renderGameTable(state);
        
        // Auto-draw: if it's my turn, no card drawn yet, not already drawing, game is active
        if (state && state.is_my_turn && !drawnCard && !autoDrawInProgress && !autoDrawDoneForTurn 
            && actionPhase === null && (state.state === 'PLAYING' || state.state === 'FINAL_TURNS')) {
            autoDrawCard();
        }
    }
}

// Game actions
async function autoDrawCard() {
    if (autoDrawInProgress || actionInFlight) return;
    if (autoDrawRetryCount >= 3) {
        // Prevent infinite retry loops â€” let the next poll cycle try again
        return;
    }
    autoDrawInProgress = true;
    autoDrawDoneForTurn = true;
    actionInFlight = true; // Block polling during auto-draw
    autoDrawRetryCount++;
    try {
        const result = await api('POST', '/draw');
        if (result.deck_empty) {
            showToast('Deck is empty â€” hand ending', 'info');
            autoDrawInProgress = false;
            actionInFlight = false;
            await loadGameState();
            return;
        }
        // Trigger fly-in animation
        drawAnimationCard = result.drawn_card;
        showDrawAnimation = true;
        drawnCard = result.drawn_card;
        actionPhase = 'drawn';
        autoDrawInProgress = false;
        actionInFlight = false; // Allow polling again
        autoDrawRetryCount = 0; // Reset retry count on success
        renderGame(gameState);
        
        // After animation completes (1200ms), switch to normal drawn state
        setTimeout(() => {
            showDrawAnimation = false;
            drawAnimationCard = null;
            if (gameState) renderGame(gameState);
        }, 1200);
    } catch (err) {
        autoDrawInProgress = false;
        autoDrawDoneForTurn = false;
        actionInFlight = false;
        // Only show toast for non-transient errors
        if (err.message && !err.message.includes('Not your turn') && !err.message.includes('Cannot draw')) {
            showToast(err.message, 'error');
        }
        // Reload state â€” the server may have advanced past our expected state
        // Reset retry count so the next poll cycle can try again
        autoDrawRetryCount = 0;
        try { await loadGameState(); } catch (e) { /* ignore nested error */ }
    }
}

async function drawCard() {
    if (actionInFlight) return;
    actionInFlight = true;
    try {
        const result = await api('POST', '/draw');
        if (result.deck_empty) {
            showToast('Deck is empty â€” hand ending', 'info');
            actionInFlight = false;
            await loadGameState();
            return;
        }
        drawnCard = result.drawn_card;
        actionPhase = 'drawn';
        actionInFlight = false;
        renderGame(gameState);
    } catch (err) {
        actionInFlight = false;
        showToast(err.message, 'error');
        // Refresh game state on error
        await loadGameState();
    }
}

async function doReplace(cardIndex) {
    if (actionInFlight) return;
    actionInFlight = true;
    try {
        const result = await api('POST', '/action', {
            type: 'draw_replace',
            target_card_index: cardIndex
        });
        actionPhase = null;
        drawnCard = null;
        autoDrawDoneForTurn = false;
        autoDrawInProgress = false;
        autoDrawRetryCount = 0;
        actionInFlight = false;
        
        // Show burned card if it was face-down
        if (result.burned_card) {
            showBurnedCard(result.burned_card);
        }
        
        await loadGameState();
    } catch (err) {
        actionInFlight = false;
        actionPhase = null;
        drawnCard = null;
        autoDrawDoneForTurn = false;
        autoDrawInProgress = false;
        autoDrawRetryCount = 0;
        showToast(err.message, 'error');
        await loadGameState();
    }
}

async function doBurnReveal(revealIndex) {
    if (actionInFlight) return;
    actionInFlight = true;
    try {
        const result = await api('POST', '/action', {
            type: 'draw_burn_reveal',
            reveal_card_index: revealIndex !== undefined ? revealIndex : null
        });
        actionPhase = null;
        drawnCard = null;
        autoDrawDoneForTurn = false;
        autoDrawInProgress = false;
        autoDrawRetryCount = 0;
        actionInFlight = false;
        await loadGameState();
    } catch (err) {
        actionInFlight = false;
        actionPhase = null;
        drawnCard = null;
        autoDrawDoneForTurn = false;
        autoDrawInProgress = false;
        autoDrawRetryCount = 0;
        showToast(err.message, 'error');
        await loadGameState();
    }
}

async function signalNextHand() {
    try {
        await api('POST', '/next-hand');
        // Reset all action/draw state for the new hand
        actionPhase = null;
        drawnCard = null;
        actionInFlight = false;
        autoDrawInProgress = false;
        autoDrawDoneForTurn = false;
        autoDrawRetryCount = 0;
        showDrawAnimation = false;
        drawAnimationCard = null;
        animatingReveal = false;
        await loadGameState();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function showBurnedCard(card) {
    const popup = document.getElementById('burned-card-popup');
    const cardEl = popup.querySelector('.burned-card-display');
    cardEl.innerHTML = createCardHTML(card.suit, card.rank, true, 'large');
    popup.querySelector('.popup-text').textContent = 'Your burned card was:';
    popup.classList.add('active');
    setTimeout(() => popup.classList.remove('active'), 2500);
}

function leaveGame() {
    clearAutoStartTimer();
    closeScoringOverlay();
    isAiGame = false;
    api('POST', '/rooms/leave').catch(() => {});
    navigate('lobby');
}

async function returnToLobby() {
    clearAutoStartTimer();
    closeScoringOverlay();
    isAiGame = false;
    try {
        await api('POST', '/rooms/leave');
    } catch (e) {
        // ignore
    }
    navigate('lobby');
}

function closeScoringOverlay() {
    const overlay = document.getElementById('scoring-overlay');
    if (overlay) overlay.classList.remove('active');
}

// ============================================================================
// Settings Modal
// ============================================================================
function initSettingsModal() {
    const modal = document.getElementById('settings-modal');
    const closeBtn = document.getElementById('close-settings-btn');

    closeBtn.onclick = () => closeSettings();
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeSettings();
    });

    // Change password form
    document.getElementById('change-password-form').onsubmit = async (e) => {
        e.preventDefault();
        const errorEl = document.getElementById('change-pw-error');
        errorEl.textContent = '';
        const currentPw = document.getElementById('settings-current-pw').value;
        const newPw = document.getElementById('settings-new-pw').value;
        const confirmPw = document.getElementById('settings-confirm-pw').value;

        if (!currentPw || !newPw || !confirmPw) {
            errorEl.textContent = 'All fields are required.';
            return;
        }
        if (newPw !== confirmPw) {
            errorEl.textContent = 'New passwords do not match.';
            return;
        }
        if (newPw.length < 3) {
            errorEl.textContent = 'New password must be at least 3 characters.';
            return;
        }

        try {
            await api('POST', '/change-password', { current_password: currentPw, new_password: newPw });
            document.getElementById('settings-current-pw').value = '';
            document.getElementById('settings-new-pw').value = '';
            document.getElementById('settings-confirm-pw').value = '';
            showToast('Password updated successfully!', 'success');
        } catch (err) {
            errorEl.textContent = err.message;
        }
    };

    // Log out
    document.getElementById('settings-logout-btn').onclick = () => {
        closeSettings();
        authToken = null;
        currentUser = null;
        navigate('login');
    };

    // Delete account flow
    document.getElementById('delete-account-btn').onclick = () => {
        document.getElementById('delete-account-btn').style.display = 'none';
        document.getElementById('delete-account-confirm').style.display = 'block';
        document.getElementById('settings-delete-pw').value = '';
        document.getElementById('delete-account-error').textContent = '';
    };

    document.getElementById('delete-account-cancel-btn').onclick = () => {
        document.getElementById('delete-account-btn').style.display = '';
        document.getElementById('delete-account-confirm').style.display = 'none';
    };

    document.getElementById('delete-account-confirm-btn').onclick = async () => {
        const errorEl = document.getElementById('delete-account-error');
        errorEl.textContent = '';
        const pw = document.getElementById('settings-delete-pw').value;
        if (!pw) {
            errorEl.textContent = 'Please enter your password.';
            return;
        }
        try {
            await api('DELETE', '/delete-account', { password: pw });
            closeSettings();
            authToken = null;
            currentUser = null;
            showToast('Account deleted.', 'info');
            navigate('login');
        } catch (err) {
            errorEl.textContent = err.message;
        }
    };
}

function openSettings() {
    // Reset delete-account state when opening
    const confirmEl = document.getElementById('delete-account-confirm');
    const btnEl = document.getElementById('delete-account-btn');
    if (confirmEl) confirmEl.style.display = 'none';
    if (btnEl) btnEl.style.display = '';
    document.getElementById('change-pw-error').textContent = '';
    document.getElementById('settings-modal').classList.add('active');
}

function closeSettings() {
    document.getElementById('settings-modal').classList.remove('active');
}

// ============================================================================
// Help Modal
// ============================================================================
function initHelpModal() {
    const modal = document.getElementById('how-to-play-modal');
    const closeBtn = document.getElementById('close-help-btn');
    const tabs = modal.querySelectorAll('.help-tab');

    // Open from lobby
    document.getElementById('how-to-play-btn').onclick = () => openHelpModal();

    // Open from in-game ? button
    document.getElementById('game-help-btn').onclick = () => openHelpModal();

    // Close
    closeBtn.onclick = () => closeHelpModal();
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeHelpModal();
    });

    // Tab switching
    tabs.forEach(tab => {
        tab.onclick = () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            modal.querySelectorAll('.help-section').forEach(s => s.classList.remove('active'));
            const target = document.getElementById('help-' + tab.dataset.help);
            if (target) target.classList.add('active');
        };
    });
}

function openHelpModal(tab) {
    const modal = document.getElementById('how-to-play-modal');
    modal.classList.add('active');
    if (tab) {
        const tabs = modal.querySelectorAll('.help-tab');
        tabs.forEach(t => {
            t.classList.toggle('active', t.dataset.help === tab);
        });
        modal.querySelectorAll('.help-section').forEach(s => s.classList.remove('active'));
        const target = document.getElementById('help-' + tab);
        if (target) target.classList.add('active');
    }
}

function closeHelpModal() {
    document.getElementById('how-to-play-modal').classList.remove('active');
}

// ============================================================================
// In-Game Info Tooltips
// ============================================================================
const TOOLTIPS = {
    draw: '<strong>Draw Phase</strong>Draw a card from the deck. You\'ll see it before choosing what to do with it.',
    replace: '<strong>Replace a Card</strong>Swap your drawn card with any card in your hand. The replaced card goes to the discard pile.',
    burn: '<strong>Burn &amp; Reveal</strong>Discard the drawn card. You can also flip one of your face-down cards face-up.',
    scoring: '<strong>Scoring</strong>Winner gets 3 base points from each loser, plus bonus points based on hand quality difference.',
    final: '<strong>Final Turns</strong>The deck is empty. Each player gets one last turn before all cards are revealed.'
};

let tooltipTimeout = null;

function showInfoTooltip(key, anchorEl) {
    const tooltip = document.getElementById('game-info-tooltip');
    tooltip.innerHTML = TOOLTIPS[key] || '';
    
    // Position near the anchor element
    const rect = anchorEl.getBoundingClientRect();
    const tooltipWidth = 260;
    let left = rect.left + rect.width / 2 - tooltipWidth / 2;
    let top = rect.bottom + 8;
    
    // Keep in viewport
    if (left < 8) left = 8;
    if (left + tooltipWidth > window.innerWidth - 8) left = window.innerWidth - tooltipWidth - 8;
    if (top + 100 > window.innerHeight) top = rect.top - 8 - 80;
    
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
    tooltip.classList.add('active');
    
    clearTimeout(tooltipTimeout);
    tooltipTimeout = setTimeout(() => {
        tooltip.classList.remove('active');
    }, 3500);
}

function hideInfoTooltip() {
    clearTimeout(tooltipTimeout);
    document.getElementById('game-info-tooltip').classList.remove('active');
}

// Delegate info icon clicks
document.addEventListener('click', (e) => {
    const infoIcon = e.target.closest('.info-icon-inline');
    if (infoIcon) {
        e.stopPropagation();
        const key = infoIcon.dataset.tip;
        if (key) showInfoTooltip(key, infoIcon);
        return;
    }
    // Clicking elsewhere hides tooltip
    hideInfoTooltip();
});

// ============================================================================
// Chat
// ============================================================================
let chatOpen = false;
let chatLastId = 0;
let chatUnread = 0;
let chatPollTimer = null;

function initChat() {
    chatLastId = 0;
    chatUnread = 0;
    updateChatBadge();
    const container = document.getElementById('chat-messages');
    if (container) container.innerHTML = '<div class="chat-empty">No messages yet</div>';

    document.getElementById('chat-toggle-btn').onclick = toggleChat;
    document.getElementById('chat-close-btn').onclick = () => setChatOpen(false);
    document.getElementById('chat-form').onsubmit = sendChatMessage;

    // Start chat polling (separate from game polling)
    stopChatPolling();
    pollChat();
    chatPollTimer = setInterval(pollChat, 2000);
}

function stopChatPolling() {
    if (chatPollTimer) {
        clearInterval(chatPollTimer);
        chatPollTimer = null;
    }
}

function toggleChat() {
    setChatOpen(!chatOpen);
}

function setChatOpen(open) {
    chatOpen = open;
    const panel = document.getElementById('chat-panel');
    if (open) {
        panel.classList.add('open');
        chatUnread = 0;
        updateChatBadge();
        // Scroll to bottom
        const msgs = document.getElementById('chat-messages');
        msgs.scrollTop = msgs.scrollHeight;
        // Focus input
        document.getElementById('chat-input').focus();
    } else {
        panel.classList.remove('open');
    }
}

function updateChatBadge() {
    const badge = document.getElementById('chat-unread-badge');
    if (!badge) return;
    if (chatUnread > 0) {
        badge.textContent = chatUnread > 9 ? '9+' : chatUnread;
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

async function pollChat() {
    if (currentScreen !== 'game') return;
    try {
        const messages = await api('GET', `/chat?since=${chatLastId}`);
        if (messages && messages.length > 0) {
            appendChatMessages(messages);
        }
    } catch (e) {
        // Silently ignore chat poll errors
    }
}

function appendChatMessages(messages) {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    // Remove empty state if present
    const empty = container.querySelector('.chat-empty');
    if (empty) empty.remove();

    const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 30;
    let newCount = 0;

    for (const msg of messages) {
        if (msg.id <= chatLastId) continue;
        chatLastId = msg.id;
        newCount++;

        const isSelf = currentUser && msg.user_id === currentUser.id;
        const div = document.createElement('div');
        div.className = `chat-msg${isSelf ? ' chat-self' : ''}`;

        const time = msg.created_at ? new Date(msg.created_at + 'Z') : new Date();
        const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        div.innerHTML = `<span class="chat-author">${escapeHtml(msg.username)}:</span><span class="chat-text">${escapeHtml(msg.message)}</span><span class="chat-time">${timeStr}</span>`;
        container.appendChild(div);
    }

    // Auto-scroll if was at bottom
    if (wasAtBottom) {
        container.scrollTop = container.scrollHeight;
    }

    // Update unread count if chat is closed
    if (!chatOpen && newCount > 0) {
        chatUnread += newCount;
        updateChatBadge();
    }
}

async function sendChatMessage(e) {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    if (!message) return;

    input.value = '';
    try {
        await api('POST', '/chat', { message });
        // Poll immediately to show the message
        await pollChat();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ============================================================================
// Client-side Hand Rank Evaluation (for live hand rank display)
// ============================================================================
function clientRankValue(r) {
    const vals = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
    return vals[r] || 0;
}

function evaluateFiveCards(cards) {
    const ranksSorted = cards.map(c => clientRankValue(c.rank)).sort((a,b) => b - a);
    const suits = cards.map(c => c.suit);
    const isFlush = new Set(suits).size === 1;

    let isStraight = false;
    let straightHigh = 0;
    const uniq = [...new Set(ranksSorted)].sort((a,b) => b - a);
    if (uniq.length >= 5) {
        for (let i = 0; i <= uniq.length - 5; i++) {
            if (uniq[i] - uniq[i+4] === 4) {
                isStraight = true;
                straightHigh = uniq[i];
                break;
            }
        }
        if (!isStraight) {
            const has = new Set(ranksSorted);
            if (has.has(14) && has.has(2) && has.has(3) && has.has(4) && has.has(5)) {
                isStraight = true;
                straightHigh = 5;
            }
        }
    }

    const counts = {};
    ranksSorted.forEach(r => { counts[r] = (counts[r]||0) + 1; });
    const freq = Object.entries(counts)
        .map(([r, c]) => [parseInt(r), c])
        .sort((a,b) => b[1] - a[1] || b[0] - a[0]);

    if (isStraight && isFlush) {
        if (straightHigh === 14 && new Set(ranksSorted).size === 5 &&
            [10,11,12,13,14].every(v => ranksSorted.includes(v))) {
            return 'Royal Flush';
        }
        return 'Straight Flush';
    }
    if (freq[0][1] === 4) return 'Four of a Kind';
    if (freq[0][1] === 3 && freq.length > 1 && freq[1][1] >= 2) return 'Full House';
    if (isFlush) return 'Flush';
    if (isStraight) return 'Straight';
    if (freq[0][1] === 3) return 'Three of a Kind';
    if (freq[0][1] === 2 && freq.length > 1 && freq[1][1] === 2) return 'Two Pair';
    if (freq[0][1] === 2) return 'One Pair';
    return 'High Card';
}

function getBestHandName(faceUpCards) {
    if (faceUpCards.length < 5) return null;
    if (faceUpCards.length === 5) return evaluateFiveCards(faceUpCards);
    // 6 cards: evaluate all C(6,5)=6 combos
    let bestRank = -1;
    let bestName = 'High Card';
    const rankOrder = ['High Card','One Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'];
    for (let skip = 0; skip < faceUpCards.length; skip++) {
        const five = faceUpCards.filter((_, i) => i !== skip);
        const name = evaluateFiveCards(five);
        const idx = rankOrder.indexOf(name);
        if (idx > bestRank) {
            bestRank = idx;
            bestName = name;
        }
    }
    return bestName;
}

// ============================================================================
// Utilities
// ============================================================================
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function suitSymbol(suit) {
    const m = { hearts: 'â™¥', diamonds: 'â™¦', clubs: 'â™£', spades: 'â™ ' };
    return m[suit] || '';
}

function suitColor(suit) {
    return (suit === 'hearts' || suit === 'diamonds') ? 'red' : 'black';
}

function createCardHTML(suit, rank, faceUp, sizeClass = '') {
    if (!faceUp) {
        return `
            <div class="card face-down ${sizeClass}">
                <div class="card-inner">
                    <div class="card-front"></div>
                    <div class="card-back">
                        <div class="card-back-pattern"></div>
                    </div>
                </div>
            </div>`;
    }
    const sym = suitSymbol(suit);
    const colorClass = `suit-${suit}`;
    return `
        <div class="card face-up ${colorClass} ${sizeClass}">
            <div class="card-inner">
                <div class="card-front">
                    <div class="card-rank-top">${rank}</div>
                    <div class="card-suit-bottom">${sym}</div>
                </div>
                <div class="card-back">
                    <div class="card-back-pattern"></div>
                </div>
            </div>
        </div>`;
}

// ============================================================================
// Init
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
    initHelpModal();
    initSettingsModal();
    initRouter();
});
