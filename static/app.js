/* app.js — Main app logic, routing, API client */

// API base — same origin, Flask serves both frontend and API
const API_BASE = '/api';

// ============================================================================
// State
// ============================================================================
let authToken = null;
let currentUser = null;
let pollingInterval = null;
let currentScreen = null;

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

    document.getElementById('logout-btn').onclick = () => {
        authToken = null;
        currentUser = null;
        navigate('login');
    };
}

async function loadUserInfo() {
    try {
        const data = await api('GET', '/me');
        currentUser = { id: data.user_id, username: data.username };
        document.getElementById('header-username').textContent = data.username;
        document.getElementById('header-points').textContent = `${data.net_points >= 0 ? '+' : ''}${data.net_points} pts`;
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
                    <div class="icon">&#9824;</div>
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
let actionPhase = null; // null, 'drawn', 'select_replace', 'select_reveal'
let drawnCard = null;
let animatingReveal = false;
let actionInFlight = false; // Prevent double-clicks and race conditions

function initGameScreen() {
    if (!authToken) { navigate('login'); return; }
    actionPhase = null;
    drawnCard = null;
    gameState = null;
    animatingReveal = false;
    actionInFlight = false;
    loadGameState();
    startPolling(loadGameState, 1500);
}

async function loadGameState() {
    if (currentScreen !== 'game') return;
    // Don't overwrite state while an action is in flight
    if (actionInFlight) return;
    try {
        const state = await api('GET', '/game-state');
        gameState = state;
        renderGame(state);
    } catch (err) {
        if (err.message.includes('Not in an active game')) {
            navigate('lobby');
        }
    }
}

function renderGame(state) {
    // Delegate to game-engine.js
    if (typeof renderGameTable === 'function') {
        // Restore drawn card state from server if we have a pending card
        if (state && state.pending_drawn_card && state.is_my_turn) {
            drawnCard = state.pending_drawn_card;
            if (actionPhase === null) {
                actionPhase = 'drawn';
            }
        } else if (state && !state.is_my_turn) {
            // Not our turn — reset action state
            actionPhase = null;
            drawnCard = null;
        }
        renderGameTable(state);
    }
}

// Game actions
async function drawCard() {
    if (actionInFlight) return;
    actionInFlight = true;
    try {
        const result = await api('POST', '/draw');
        if (result.deck_empty) {
            showToast('Deck is empty — hand ending', 'info');
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
        actionInFlight = false;
        await loadGameState();
    } catch (err) {
        actionInFlight = false;
        actionPhase = null;
        drawnCard = null;
        showToast(err.message, 'error');
        await loadGameState();
    }
}

async function signalNextHand() {
    try {
        await api('POST', '/next-hand');
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
    api('POST', '/rooms/leave').catch(() => {});
    navigate('lobby');
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
    const m = { hearts: '\u2665', diamonds: '\u2666', clubs: '\u2663', spades: '\u2660' };
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
                    <div class="card-rank-top">
                        <span>${rank}</span>
                        <span class="card-rank-suit">${sym}</span>
                    </div>
                    <div class="card-suit-center">${sym}</div>
                    <div class="card-rank-bottom">
                        <span>${rank}</span>
                        <span class="card-rank-suit">${sym}</span>
                    </div>
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
document.addEventListener('DOMContentLoaded', initRouter);
