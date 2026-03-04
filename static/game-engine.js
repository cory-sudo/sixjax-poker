/* game-engine.js — Game table rendering and interaction logic */

// ============================================================================
// Game Table Renderer
// ============================================================================
function renderGameTable(state) {
    if (!state) return;

    const me = state.players.find(p => p.is_self);
    const opponents = state.players.filter(p => !p.is_self);

    // Top bar
    renderTopBar(state, me);

    // Opponents
    renderOpponents(state, opponents);

    // Center area
    renderCenter(state, me);

    // Player hand
    renderPlayerHand(state, me);

    // Scoring overlay
    if (state.state === 'SCORING') {
        renderScoringOverlay(state, me);
    } else {
        document.getElementById('scoring-overlay').classList.remove('active');
        // Clear auto-start timer if we've moved away from SCORING
        clearAutoStartTimer();
    }
}

// ============================================================================
// Top Bar
// ============================================================================
function renderTopBar(state, me) {
    const handInfo = document.getElementById('hand-info');
    const pointVal = document.getElementById('point-value-display');
    
    let stateLabel = '';
    if (state.state === 'FINAL_TURNS') stateLabel = ' — FINAL TURNS <span class="info-icon-inline" data-tip="final" title="What is this?">?</span>';
    else if (state.state === 'SCORING') stateLabel = ' — SCORING';
    
    handInfo.innerHTML = `Hand #${state.hand_number}${stateLabel}`;
    pointVal.textContent = `${state.point_value}x pts`;
    
    document.getElementById('leave-game-btn').onclick = leaveGame;
}

// ============================================================================
// Opponents
// ============================================================================
function renderOpponents(state, opponents) {
    const area = document.getElementById('opponents-area');
    
    area.innerHTML = opponents.map(opp => {
        const isActive = state.current_turn_seat === opp.seat && 
                         state.state !== 'SCORING';
        const activeClass = isActive ? 'active-turn' : '';
        const buttonIcon = state.button_seat === opp.seat ? ' <span title="Button" style="color:var(--warning)">&#9679;</span>' : '';
        const pts = opp.net_points || 0;
        const ptsClass = pts > 0 ? 'pts-positive' : pts < 0 ? 'pts-negative' : 'pts-zero';
        const ptsText = pts > 0 ? `+${pts}` : `${pts}`;
        
        const cardsHTML = opp.cards.map(c => {
            if (c.face_up) {
                return createCardHTML(c.suit, c.rank, true, 'mini');
            }
            return createCardHTML(null, null, false, 'mini');
        }).join('');
        
        return `
            <div class="opponent-panel ${activeClass}">
                <div class="opponent-name">
                    ${escapeHtml(opp.username)}${buttonIcon}
                    <span class="player-pts ${ptsClass}">${ptsText}</span>
                </div>
                <div class="opponent-cards">${cardsHTML}</div>
                ${opp.has_left ? '<div style="color:var(--danger);font-size:var(--text-xs)">LEFT</div>' : opp.is_disqualified ? '<div style="color:var(--danger);font-size:var(--text-xs)">DISQUALIFIED</div>' : ''}
            </div>`;
    }).join('');
}

// ============================================================================
// Center Area
// ============================================================================
function renderCenter(state, me) {
    // Draw pile
    const drawPile = document.getElementById('draw-pile');
    const deckCount = state.deck_count;
    
    if (deckCount > 0) {
        drawPile.innerHTML = `
            <div class="draw-pile-cards">
                ${deckCount > 2 ? '<div class="pile-card"><div class="card-back-pattern"></div></div>' : ''}
                ${deckCount > 1 ? '<div class="pile-card"><div class="card-back-pattern"></div></div>' : ''}
                <div class="pile-card"><div class="card-back-pattern"></div></div>
            </div>
            <span class="pile-count">${deckCount}</span>`;
    } else {
        drawPile.innerHTML = `
            <div class="discard-area">Empty</div>`;
    }

    // Last drawn card / YOUR drawn card display with animation
    const lastDrawn = document.getElementById('last-drawn-card');
    if (showDrawAnimation && drawAnimationCard) {
        // Show fly-in animation card (large, then shrinks)
        const c = drawAnimationCard;
        lastDrawn.innerHTML = `
            <div class="draw-animation-container">
                <div class="draw-animation-card">
                    ${createCardHTML(c.suit, c.rank, true, 'drawn')}
                </div>
            </div>`;
    } else if (drawnCard && state.is_my_turn && actionPhase) {
        // Show the player's drawn card normally (post-animation)
        const c = drawnCard;
        lastDrawn.innerHTML = `
            <div class="drawn-card-highlight">
                <div class="drawn-label">You Drew</div>
                ${createCardHTML(c.suit, c.rank, true, 'drawn')}
            </div>`;
    } else if (state.last_drawn_card) {
        const c = state.last_drawn_card;
        lastDrawn.innerHTML = `
            <div class="discard-pile-display">
                <div class="discard-label">Discard</div>
                ${createCardHTML(c.suit, c.rank, true)}
            </div>`;
    } else {
        lastDrawn.innerHTML = '<div class="discard-area"></div>';
    }

    // Last action text
    const actionText = document.getElementById('last-action-text');
    actionText.textContent = state.last_action || '';

    // Action area
    renderActionArea(state, me);
}

// ============================================================================
// Action Area (turn buttons)
// ============================================================================
function renderActionArea(state, me) {
    const area = document.getElementById('action-area');
    const turnIndicator = document.getElementById('turn-indicator');
    const actionButtons = document.getElementById('action-buttons');
    
    if (state.state === 'SCORING') {
        turnIndicator.textContent = 'Hand complete!';
        turnIndicator.className = 'turn-indicator';
        actionButtons.innerHTML = '';
        return;
    }

    const isMyTurn = state.is_my_turn;
    const currentPlayer = state.players.find(p => p.seat === state.current_turn_seat);
    const currentName = currentPlayer ? currentPlayer.username : '...';

    if (!isMyTurn) {
        turnIndicator.textContent = `Waiting for ${currentName}...`;
        turnIndicator.className = 'turn-indicator';
        actionButtons.innerHTML = '';
        return;
    }

    // It's my turn
    const isFinalTurn = state.state === 'FINAL_TURNS';
    turnIndicator.textContent = isFinalTurn ? 'Final Turn!' : 'Your Turn!';
    turnIndicator.className = 'turn-indicator your-turn';

    const allFaceUp = me.cards.every(c => c.face_up);
    const hasFaceDown = me.cards.some(c => !c.face_up);

    // During animation or before card is drawn, show nothing
    if (showDrawAnimation || actionPhase === null) {
        actionButtons.innerHTML = autoDrawInProgress 
            ? '<div style="color:var(--text-secondary);font-size:var(--text-sm)">Drawing card...</div>' 
            : '';
        return;
    }

    // Card has been drawn — show the 3 action buttons
    if (actionPhase === 'drawn') {
        if (allFaceUp) {
            // All face-up: can only Replace (skip and reveal don't make sense)
            actionButtons.innerHTML = `
                <div class="action-btn-group">
                    <button class="action-btn action-btn-replace" onclick="enterReplaceMode()">Replace</button>
                    <button class="action-btn action-btn-skip" onclick="doSkip()">Skip</button>
                </div>`;
        } else {
            actionButtons.innerHTML = `
                <div class="action-btn-group">
                    <button class="action-btn action-btn-skip" onclick="doSkip()">Skip</button>
                    <button class="action-btn action-btn-replace" onclick="enterReplaceMode()">Replace</button>
                    <button class="action-btn action-btn-reveal" onclick="enterRevealMode()">Reveal</button>
                </div>`;
        }
    } else if (actionPhase === 'select_replace') {
        actionButtons.innerHTML = `
            <div style="color:var(--accent);font-size:var(--text-sm)">
                Tap a card in your hand to replace
            </div>
            <button class="btn btn-sm btn-secondary" onclick="cancelAction()">Cancel</button>`;
    } else if (actionPhase === 'select_reveal') {
        actionButtons.innerHTML = `
            <div style="color:var(--accent);font-size:var(--text-sm)">
                Tap a face-down card to reveal
            </div>
            <button class="btn btn-sm btn-secondary" onclick="cancelAction()">Cancel</button>`;
    }
}

function doSkip() {
    doBurnReveal(); // calls with no reveal index = just burn
}

function enterReplaceMode() {
    actionPhase = 'select_replace';
    renderGame(gameState);
}

function enterRevealMode() {
    actionPhase = 'select_reveal';
    renderGame(gameState);
}

// Keep enterBurnMode as alias for compatibility
function enterBurnMode() {
    actionPhase = 'select_reveal';
    renderGame(gameState);
}

function cancelAction() {
    actionPhase = 'drawn';
    renderGame(gameState);
}

// ============================================================================
// Player Hand
// ============================================================================
function renderPlayerHand(state, me) {
    const area = document.getElementById('player-cards');
    const label = document.getElementById('player-label');
    
    const buttonIcon = state.button_seat === me.seat ? ' <span style="color:var(--warning)" title="Button">&#9679;</span>' : '';
    const myPts = me.net_points || 0;
    const myPtsClass = myPts > 0 ? 'pts-positive' : myPts < 0 ? 'pts-negative' : 'pts-zero';
    const myPtsText = myPts > 0 ? `+${myPts}` : `${myPts}`;
    label.innerHTML = `${escapeHtml(me.username)}${buttonIcon} <span class="player-pts ${myPtsClass}">${myPtsText}</span>`;

    const isMyTurn = state.is_my_turn;
    const allFaceUp = me.cards.every(c => c.face_up);

    area.innerHTML = me.cards.map((c, idx) => {
        let selectable = false;
        let clickHandler = '';

        if (isMyTurn && state.state !== 'SCORING') {
            if (actionPhase === 'drawn' && allFaceUp) {
                // All face-up, must replace
                selectable = true;
                clickHandler = `onclick="doReplace(${idx})"`;
            } else if (actionPhase === 'select_replace') {
                selectable = true;
                clickHandler = `onclick="doReplace(${idx})"`;
            } else if (actionPhase === 'select_reveal' && !c.face_up) {
                selectable = true;
                clickHandler = `onclick="doBurnReveal(${idx})"`;
            }
        }

        const selectableClass = selectable ? 'selectable' : '';

        if (c.face_up) {
            return `
                <div class="card face-up suit-${c.suit} ${selectableClass}" ${clickHandler}>
                    <div class="card-inner">
                        <div class="card-front">
                            <div class="card-rank-top">
                                <span>${c.rank}</span>
                                <span class="card-rank-suit">${suitSymbol(c.suit)}</span>
                            </div>
                            <div class="card-suit-center">${suitSymbol(c.suit)}</div>
                            <div class="card-rank-bottom">
                                <span>${c.rank}</span>
                                <span class="card-rank-suit">${suitSymbol(c.suit)}</span>
                            </div>
                        </div>
                        <div class="card-back">
                            <div class="card-back-pattern"></div>
                        </div>
                    </div>
                </div>`;
        } else {
            return `
                <div class="card face-down ${selectableClass}" ${clickHandler}>
                    <div class="card-inner">
                        <div class="card-front"></div>
                        <div class="card-back">
                            <div class="card-back-pattern"></div>
                        </div>
                    </div>
                </div>`;
        }
    }).join('');
}

// ============================================================================
// Scoring Overlay
// ============================================================================
function renderScoringOverlay(state, me) {
    const overlay = document.getElementById('scoring-overlay');
    const content = document.getElementById('scoring-content');

    // Sort players by hand rank (best first)
    const sorted = [...state.players].sort((a, b) => {
        return (b.best_hand_rank || 0) - (a.best_hand_rank || 0);
    });

    // Determine winner(s)
    const topRank = sorted[0].best_hand_rank;
    const winners = sorted.filter(p => p.best_hand_rank === topRank);

    let playersHTML = sorted.map(p => {
        // Find score data
        const scoreEntry = state.scores.find(s => s.user_id === p.user_id);
        let pointChange = 0;
        if (scoreEntry) {
            pointChange = scoreEntry.net;
        }
        
        // Winner = gained points this round (not just best hand rank)
        const isWinner = pointChange > 0;
        const winnerClass = isWinner ? 'winner' : '';
        
        const changeClass = pointChange > 0 ? 'positive' : pointChange < 0 ? 'negative' : '';
        const changeText = pointChange > 0 ? `+${pointChange}` : pointChange < 0 ? `${pointChange}` : '0';
        
        // Show all cards now
        const cardsHTML = p.cards.map(c => {
            if (c.face_up && c.suit) {
                return createCardHTML(c.suit, c.rank, true, 'mini');
            }
            return createCardHTML(null, null, false, 'mini');
        }).join('');

        return `
            <div class="scoring-player ${winnerClass}">
                <div>
                    <div class="player-hand-name">
                        ${isWinner ? '&#127942; ' : ''}${escapeHtml(p.username)}
                    </div>
                    <div class="player-hand-type">${p.best_hand_name || 'N/A'}</div>
                    <div style="display:flex;gap:2px;margin-top:4px">${cardsHTML}</div>
                </div>
                <div class="point-change ${changeClass}">${changeText}</div>
            </div>`;
    }).join('');

    const alreadyReady = state.ready_for_next && state.ready_for_next.includes(me.user_id);
    const readyBtnText = alreadyReady ? 'Waiting for others...' : 'Ready for Next Hand';
    const readyBtnClass = alreadyReady ? 'btn btn-secondary' : 'btn btn-primary';
    const readyBtnDisabled = alreadyReady ? 'disabled' : '';

    // Auto-start countdown timer logic
    // Only start timer if: not already ready, not already running
    if (!alreadyReady && !autoStartTimerRunning) {
        autoStartTimerRunning = true;
        autoStartCountdown = 10;
        autoStartTimer = setInterval(() => {
            autoStartCountdown--;
            // Update countdown text in DOM without full re-render
            const countdownEl = document.getElementById('auto-start-countdown');
            if (countdownEl) {
                countdownEl.textContent = `Auto-ready in ${autoStartCountdown}s...`;
            }
            if (autoStartCountdown <= 0) {
                clearAutoStartTimer();
                signalNextHand();
            }
        }, 1000);
    }

    // If already ready, ensure timer is cleared
    if (alreadyReady) {
        clearAutoStartTimer();
    }

    const countdownText = (!alreadyReady && autoStartTimerRunning)
        ? `Auto-ready in ${autoStartCountdown}s...`
        : '';

    content.innerHTML = `
        <h2>Hand Complete <span class="info-icon-inline" data-tip="scoring" title="Scoring info">?</span></h2>
        ${playersHTML}
        <div class="scoring-actions">
            <button class="${readyBtnClass}" onclick="onReadyForNextHand()" ${readyBtnDisabled}>
                ${readyBtnText}
            </button>
            ${countdownText ? `<div id="auto-start-countdown" class="auto-start-countdown">${countdownText}</div>` : '<div id="auto-start-countdown" class="auto-start-countdown" style="display:none"></div>'}
            <button class="btn btn-sm btn-secondary" onclick="returnToLobby()" style="margin-top:var(--sp-2)">
                Return to Lobby
            </button>
        </div>`;

    overlay.classList.add('active');
}

function onReadyForNextHand() {
    clearAutoStartTimer();
    // Update UI immediately to show waiting state
    const readyBtn = document.querySelector('#scoring-content .scoring-actions .btn-primary');
    if (readyBtn) {
        readyBtn.textContent = 'Waiting for others...';
        readyBtn.className = 'btn btn-secondary';
        readyBtn.disabled = true;
    }
    const countdownEl = document.getElementById('auto-start-countdown');
    if (countdownEl) countdownEl.style.display = 'none';
    signalNextHand();
}
