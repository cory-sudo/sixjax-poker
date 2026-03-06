"""SixJax Poker — Flask Backend API"""

import json, os, sqlite3, hashlib, base64, random, time
from itertools import combinations
from collections import Counter
from flask import Flask, request, jsonify, send_from_directory, g

# ---------------------------------------------------------------------------
# Flask App
# ---------------------------------------------------------------------------
app = Flask(__name__, static_folder='static', static_url_path='')

import logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@app.errorhandler(Exception)
def handle_exception(e):
    logger.error(f"Unhandled exception: {e}", exc_info=True)
    return jsonify({"error": "Internal server error"}), 500

# ---------------------------------------------------------------------------
# Database Path — uses Railway Volume for persistence across deploys
# ---------------------------------------------------------------------------
# Railway Volumes provide persistent storage that survives redeploys.
# When a volume is attached, RAILWAY_VOLUME_MOUNT_PATH is set automatically.
# Priority: 1) Railway Volume  2) App directory  3) /tmp (fallback)
_volume_mount = os.environ.get('RAILWAY_VOLUME_MOUNT_PATH', '')
if _volume_mount:
    # Persistent volume is attached — use it
    os.makedirs(_volume_mount, exist_ok=True)
    DB_PATH = os.path.join(_volume_mount, 'data.db')
    logger.info(f"Using Railway Volume for DB: {DB_PATH}")
else:
    _app_dir = os.path.dirname(os.path.abspath(__file__))
    _db_candidate = os.path.join(_app_dir, 'data.db')
    try:
        _test_file = os.path.join(_app_dir, '.write_test')
        with open(_test_file, 'w') as f:
            f.write('ok')
        os.remove(_test_file)
        DB_PATH = _db_candidate
    except OSError:
        DB_PATH = '/tmp/data.db'
    logger.info(f"No Railway Volume detected — using: {DB_PATH} (data will NOT persist across deploys)")

logger.info(f"Database path: {DB_PATH}")

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=10)
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.execute("PRAGMA busy_timeout=10000")
        g.db.row_factory = sqlite3.Row
    return g.db

@app.teardown_appcontext
def close_db(exc):
    db = g.pop('db', None)
    if db is not None:
        db.close()

def init_db():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        total_points_won INTEGER DEFAULT 0,
        total_points_lost INTEGER DEFAULT 0,
        games_played INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_code TEXT UNIQUE NOT NULL,
        host_user_id INTEGER,
        point_value REAL DEFAULT 1.0,
        status TEXT DEFAULT 'waiting',
        max_players INTEGER DEFAULT 4,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS room_players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER,
        user_id INTEGER,
        seat_position INTEGER,
        is_ready INTEGER DEFAULT 0,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS game_hands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER,
        hand_number INTEGER,
        button_seat INTEGER,
        current_turn_seat INTEGER,
        deck TEXT,
        state TEXT DEFAULT 'DEALING',
        end_triggered_by INTEGER,
        final_turn_queue TEXT,
        winner_user_id INTEGER,
        last_drawn_card TEXT,
        last_action TEXT,
        pending_drawn_card TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS player_hands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_hand_id INTEGER,
        user_id INTEGER,
        seat_position INTEGER,
        cards TEXT,
        is_disqualified INTEGER DEFAULT 0,
        best_hand_name TEXT,
        best_hand_rank INTEGER,
        bonus_value INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_hand_id INTEGER,
        winner_id INTEGER,
        loser_id INTEGER,
        base_points INTEGER DEFAULT 3,
        bonus_points INTEGER DEFAULT 0,
        total_points INTEGER
    );
    CREATE TABLE IF NOT EXISTS next_hand_ready (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER,
        user_id INTEGER,
        UNIQUE(room_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)
    try:
        db.execute("ALTER TABLE game_hands ADD COLUMN pending_drawn_card TEXT")
    except Exception:
        pass
    db.commit()
    db.close()

# ---------------------------------------------------------------------------
# Auth Helpers
# ---------------------------------------------------------------------------
def make_token(user_id):
    return base64.b64encode(str(user_id).encode()).decode()

def hash_password(pw):
    return hashlib.sha256(pw.encode()).hexdigest()

def get_user_id():
    auth = request.headers.get('Authorization', '')
    if auth.startswith('Bearer '):
        try:
            token = auth[7:]
            return int(base64.b64decode(token).decode())
        except Exception:
            pass
    token = request.args.get('token')
    if token:
        try:
            return int(base64.b64decode(token).decode())
        except Exception:
            pass
    return None

def require_auth():
    uid = get_user_id()
    if uid is None:
        return None
    return uid

def generate_room_code():
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return ''.join(random.choice(chars) for _ in range(5))

# ---------------------------------------------------------------------------
# Deck & Cards
# ---------------------------------------------------------------------------
SUITS = ['hearts', 'diamonds', 'clubs', 'spades']
RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A']

def new_deck():
    deck = [{"suit": s, "rank": r} for s in SUITS for r in RANKS]
    for i in range(len(deck) - 1, 0, -1):
        j = random.randint(0, i)
        deck[i], deck[j] = deck[j], deck[i]
    return deck

def rank_value(r):
    vals = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}
    return vals.get(r, 0)

def suit_symbol(suit):
    symbols = {'hearts': '♥', 'diamonds': '♦', 'clubs': '♣', 'spades': '♠'}
    return symbols.get(suit, '')

# ---------------------------------------------------------------------------
# Poker Hand Evaluation
# ---------------------------------------------------------------------------
def evaluate_five(cards):
    ranks_sorted = sorted([rank_value(c['rank']) for c in cards], reverse=True)
    suits = [c['suit'] for c in cards]
    is_flush = len(set(suits)) == 1

    is_straight = False
    straight_high = 0
    uniq = sorted(set(ranks_sorted), reverse=True)
    if len(uniq) >= 5:
        for i in range(len(uniq) - 4):
            if uniq[i] - uniq[i+4] == 4:
                is_straight = True
                straight_high = uniq[i]
                break
        if not is_straight and set([14,2,3,4,5]).issubset(set(ranks_sorted)):
            is_straight = True
            straight_high = 5

    counts = Counter(ranks_sorted)
    freq = sorted(counts.items(), key=lambda x: (x[1], x[0]), reverse=True)

    if is_straight and is_flush:
        if straight_high == 14:
            if set(ranks_sorted) == {10,11,12,13,14}:
                return (9, [14], "Royal Flush", 9)
        return (8, [straight_high], "Straight Flush", 7)

    if freq[0][1] == 4:
        quad_rank = freq[0][0]
        kicker = [r for r in ranks_sorted if r != quad_rank][:1]
        return (7, [quad_rank] + kicker, "Four of a Kind", 5)

    if freq[0][1] == 3 and freq[1][1] >= 2:
        trip_rank = freq[0][0]
        pair_rank = freq[1][0]
        return (6, [trip_rank, pair_rank], "Full House", 3)

    if is_flush:
        return (5, ranks_sorted, "Flush", 1)

    if is_straight:
        return (4, [straight_high], "Straight", 1)

    if freq[0][1] == 3:
        trip_rank = freq[0][0]
        kickers = sorted([r for r in ranks_sorted if r != trip_rank], reverse=True)[:2]
        return (3, [trip_rank] + kickers, "Three of a Kind", 0)

    if freq[0][1] == 2 and freq[1][1] == 2:
        high_pair = max(freq[0][0], freq[1][0])
        low_pair = min(freq[0][0], freq[1][0])
        kicker = [r for r in ranks_sorted if r != high_pair and r != low_pair][:1]
        return (2, [high_pair, low_pair] + kicker, "Two Pair", 0)

    if freq[0][1] == 2:
        pair_rank = freq[0][0]
        kickers = sorted([r for r in ranks_sorted if r != pair_rank], reverse=True)[:3]
        return (1, [pair_rank] + kickers, "One Pair", 0)

    return (0, ranks_sorted, "High Card", 0)

def best_hand_from_six(cards):
    best = None
    for combo in combinations(range(6), 5):
        five = [cards[i] for i in combo]
        result = evaluate_five(five)
        if best is None or (result[0], result[1]) > (best[0], best[1]):
            best = result
    return best

# ---------------------------------------------------------------------------
# Game Logic
# ---------------------------------------------------------------------------
def get_turn_order(button_seat, num_players):
    order = []
    seat = button_seat
    for _ in range(num_players):
        seat = seat % num_players + 1
        order.append(seat)
    return order

def deal_hand(db, room_id, hand_number, button_seat, player_seats):
    deck = new_deck()
    num_players = len(player_seats)
    turn_order = get_turn_order(button_seat, num_players)
    seat_to_user = {sp: uid for uid, sp in player_seats}

    player_cards = {sp: [] for _, sp in player_seats}

    for round_num in range(6):
        for seat in turn_order:
            if seat in player_cards:
                card = deck.pop(0)
                card['face_up'] = round_num < 2
                player_cards[seat].append(card)

    first_turn = turn_order[0]

    cur = db.execute("""
        INSERT INTO game_hands (room_id, hand_number, button_seat, current_turn_seat, deck, state)
        VALUES (?, ?, ?, ?, ?, 'PLAYING')
    """, (room_id, hand_number, button_seat, first_turn, json.dumps(deck)))
    hand_id = cur.lastrowid

    for uid, sp in player_seats:
        db.execute("""
            INSERT INTO player_hands (game_hand_id, user_id, seat_position, cards)
            VALUES (?, ?, ?, ?)
        """, (hand_id, uid, sp, json.dumps(player_cards[sp])))

    db.commit()
    return hand_id

def check_all_face_up(cards):
    return all(c.get('face_up', False) for c in cards)

def advance_turn(db, hand_id, current_seat, num_players, hand_state):
    hand = db.execute("SELECT * FROM game_hands WHERE id=?", (hand_id,)).fetchone()
    state = hand['state']

    current_ph = db.execute(
        "SELECT * FROM player_hands WHERE game_hand_id=? AND seat_position=?",
        (hand_id, current_seat)
    ).fetchone()
    current_cards = json.loads(current_ph['cards'])

    all_players = db.execute(
        "SELECT * FROM player_hands WHERE game_hand_id=? ORDER BY seat_position",
        (hand_id,)
    ).fetchall()
    num_players = len(all_players)
    button_seat = hand['button_seat']

    actual_seats = sorted([p['seat_position'] for p in all_players])
    turn_order = get_turn_order(button_seat, num_players)

    if current_seat not in turn_order:
        if current_seat in actual_seats:
            idx = actual_seats.index(current_seat)
            next_seat = actual_seats[(idx + 1) % num_players]
        else:
            next_seat = actual_seats[0]
        db.execute("UPDATE game_hands SET current_turn_seat=? WHERE id=?",
                  (next_seat, hand_id))
        db.commit()
        return

    deck = json.loads(hand['deck'])
    if len(deck) == 0:
        finish_hand(db, hand_id)
        return

    if state == 'PLAYING':
        if check_all_face_up(current_cards):
            final_queue = []
            idx = turn_order.index(current_seat)
            for i in range(1, num_players):
                next_seat = turn_order[(idx + i) % num_players]
                final_queue.append(next_seat)

            if len(final_queue) == 0:
                finish_hand(db, hand_id)
                return

            next_turn = final_queue.pop(0)
            db.execute("""
                UPDATE game_hands SET state='FINAL_TURNS', end_triggered_by=?,
                final_turn_queue=?, current_turn_seat=?
                WHERE id=?
            """, (current_seat, json.dumps(final_queue), next_turn, hand_id))
            db.commit()
            return
        else:
            idx = turn_order.index(current_seat)
            next_seat = turn_order[(idx + 1) % num_players]
            db.execute("UPDATE game_hands SET current_turn_seat=? WHERE id=?",
                      (next_seat, hand_id))
            db.commit()
            return

    elif state == 'FINAL_TURNS':
        final_queue = json.loads(hand['final_turn_queue']) if hand['final_turn_queue'] else []
        if len(final_queue) == 0:
            finish_hand(db, hand_id)
            return
        else:
            next_turn = final_queue.pop(0)
            db.execute("""
                UPDATE game_hands SET current_turn_seat=?, final_turn_queue=?
                WHERE id=?
            """, (next_turn, json.dumps(final_queue), hand_id))
            db.commit()
            return

def finish_hand(db, hand_id):
    hand = db.execute("SELECT * FROM game_hands WHERE id=?", (hand_id,)).fetchone()
    all_ph = db.execute(
        "SELECT * FROM player_hands WHERE game_hand_id=?", (hand_id,)
    ).fetchall()

    for ph in all_ph:
        cards = json.loads(ph['cards'])
        for c in cards:
            c['face_up'] = True
        db.execute("UPDATE player_hands SET cards=? WHERE id=?",
                  (json.dumps(cards), ph['id']))

    evaluations = []
    for ph in all_ph:
        cards = json.loads(ph['cards'])
        for c in cards:
            c['face_up'] = True

        if ph['is_disqualified']:
            evaluations.append({
                'user_id': ph['user_id'],
                'seat': ph['seat_position'],
                'rank': 0, 'tiebreakers': [0],
                'name': 'High Card (DQ)', 'bonus': 0,
                'disqualified': True, 'ph_id': ph['id']
            })
        else:
            rank, tiebreakers, name, bonus = best_hand_from_six(cards)
            evaluations.append({
                'user_id': ph['user_id'],
                'seat': ph['seat_position'],
                'rank': rank, 'tiebreakers': tiebreakers,
                'name': name, 'bonus': bonus,
                'disqualified': False, 'ph_id': ph['id']
            })

    for ev in evaluations:
        db.execute("""
            UPDATE player_hands SET best_hand_name=?, best_hand_rank=?, bonus_value=?
            WHERE id=?
        """, (ev['name'], ev['rank'], ev['bonus'], ev['ph_id']))

    evaluations.sort(key=lambda x: (x['rank'], x['tiebreakers']), reverse=True)

    top = evaluations[0]
    winners = [e for e in evaluations if e['rank'] == top['rank'] and e['tiebreakers'] == top['tiebreakers']]
    losers = [e for e in evaluations if e not in winners]

    num_winners = len(winners)

    if len(losers) == 0:
        db.execute("UPDATE game_hands SET state='SCORING', winner_user_id=NULL WHERE id=?", (hand_id,))
    else:
        for loser in losers:
            for winner in winners:
                base_per_loser = 3
                bonus = max(0, winner['bonus'] - loser['bonus'])
                total = base_per_loser + bonus
                split_base = base_per_loser / num_winners
                split_bonus = bonus / num_winners
                split_total = total / num_winners

                db.execute("""
                    INSERT INTO scores (game_hand_id, winner_id, loser_id, base_points, bonus_points, total_points)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (hand_id, winner['user_id'], loser['user_id'],
                      round(split_base), round(split_bonus), round(split_total)))

        room = db.execute("SELECT * FROM rooms WHERE id=?", (hand['room_id'],)).fetchone()
        point_value = room['point_value'] if room else 1.0

        for winner in winners:
            total_won = sum(
                s['total_points'] for s in
                db.execute("SELECT total_points FROM scores WHERE game_hand_id=? AND winner_id=?",
                          (hand_id, winner['user_id'])).fetchall()
            )
            db.execute("""
                UPDATE users SET total_points_won = total_points_won + ?,
                games_played = games_played + 1 WHERE id=?
            """, (round(total_won * point_value), winner['user_id']))

        for loser in losers:
            total_lost = sum(
                s['total_points'] for s in
                db.execute("SELECT total_points FROM scores WHERE game_hand_id=? AND loser_id=?",
                          (hand_id, loser['user_id'])).fetchall()
            )
            db.execute("""
                UPDATE users SET total_points_lost = total_points_lost + ?,
                games_played = games_played + 1 WHERE id=?
            """, (round(total_lost * point_value), loser['user_id']))

        winner_id = winners[0]['user_id'] if num_winners == 1 else None
        db.execute("UPDATE game_hands SET state='SCORING', winner_user_id=? WHERE id=?",
                  (winner_id, hand_id))

    db.commit()

# ---------------------------------------------------------------------------
# Sanitize Game State
# ---------------------------------------------------------------------------
def sanitize_game_state(db, hand_id, user_id):
    hand = db.execute("SELECT * FROM game_hands WHERE id=?", (hand_id,)).fetchone()
    if not hand:
        return None

    all_ph = db.execute(
        "SELECT * FROM player_hands WHERE game_hand_id=? ORDER BY seat_position",
        (hand_id,)
    ).fetchall()

    room = db.execute("SELECT * FROM rooms WHERE id=?", (hand['room_id'],)).fetchone()

    # Get current room players to detect who has left
    current_room_players = set(
        r['user_id'] for r in db.execute(
            "SELECT user_id FROM room_players WHERE room_id=?",
            (hand['room_id'],)
        ).fetchall()
    )

    user_ids = [ph['user_id'] for ph in all_ph]
    users = {}
    # Calculate per-room session points (not lifetime)
    room_points = {}
    for uid in user_ids:
        u = db.execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone()
        users[uid] = u['username'] if u else 'Unknown'
        # Sum points won in this room across all hands
        won = db.execute("""
            SELECT COALESCE(SUM(s.total_points), 0) as total
            FROM scores s
            JOIN game_hands gh ON s.game_hand_id = gh.id
            WHERE gh.room_id = ? AND s.winner_id = ?
        """, (hand['room_id'], uid)).fetchone()['total']
        # Sum points lost in this room across all hands
        lost = db.execute("""
            SELECT COALESCE(SUM(s.total_points), 0) as total
            FROM scores s
            JOIN game_hands gh ON s.game_hand_id = gh.id
            WHERE gh.room_id = ? AND s.loser_id = ?
        """, (hand['room_id'], uid)).fetchone()['total']
        room_points[uid] = won - lost

    players = []
    for ph in all_ph:
        cards_raw = json.loads(ph['cards'])
        sanitized_cards = []

        for c in cards_raw:
            if c.get('face_up'):
                sanitized_cards.append({
                    'suit': c['suit'], 'rank': c['rank'], 'face_up': True
                })
            else:
                sanitized_cards.append({'face_up': False})

        players.append({
            'user_id': ph['user_id'],
            'username': users[ph['user_id']],
            'seat': ph['seat_position'],
            'cards': sanitized_cards,
            'is_self': ph['user_id'] == user_id,
            'is_disqualified': bool(ph['is_disqualified']),
            'has_left': ph['user_id'] not in current_room_players,
            'best_hand_name': ph['best_hand_name'],
            'best_hand_rank': ph['best_hand_rank'],
            'bonus_value': ph['bonus_value'],
            'net_points': room_points[ph['user_id']]
        })

    deck = json.loads(hand['deck']) if hand['deck'] else []
    last_drawn = json.loads(hand['last_drawn_card']) if hand['last_drawn_card'] else None

    score_data = []
    if hand['state'] == 'SCORING':
        scores = db.execute("SELECT * FROM scores WHERE game_hand_id=?", (hand_id,)).fetchall()
        player_scores = {}
        for s in scores:
            wid = s['winner_id']
            lid = s['loser_id']
            if wid not in player_scores:
                player_scores[wid] = {'won': 0, 'lost': 0}
            if lid not in player_scores:
                player_scores[lid] = {'won': 0, 'lost': 0}
            player_scores[wid]['won'] += s['total_points']
            player_scores[lid]['lost'] += s['total_points']

        for uid_key, vals in player_scores.items():
            score_data.append({
                'user_id': uid_key,
                'username': users.get(uid_key, 'Unknown'),
                'points_won': vals['won'],
                'points_lost': vals['lost'],
                'net': vals['won'] - vals['lost']
            })

    ready_for_next = [r['user_id'] for r in
        db.execute("SELECT user_id FROM next_hand_ready WHERE room_id=?",
                   (hand['room_id'],)).fetchall()]

    my_seat = next((p['seat'] for p in players if p['is_self']), -1)
    pending_card = None
    if hand['pending_drawn_card'] and hand['current_turn_seat'] == my_seat:
        pending_card = json.loads(hand['pending_drawn_card'])

    return {
        'hand_id': hand_id,
        'hand_number': hand['hand_number'],
        'state': hand['state'],
        'button_seat': hand['button_seat'],
        'current_turn_seat': hand['current_turn_seat'],
        'deck_count': len(deck),
        'players': players,
        'last_drawn_card': last_drawn,
        'last_action': hand['last_action'],
        'end_triggered_by': hand['end_triggered_by'],
        'scores': score_data,
        'point_value': room['point_value'] if room else 1.0,
        'is_my_turn': hand['current_turn_seat'] == my_seat,
        'room_id': hand['room_id'],
        'ready_for_next': ready_for_next,
        'pending_drawn_card': pending_card
    }

# ---------------------------------------------------------------------------
# Room Helpers
# ---------------------------------------------------------------------------
def leave_current_room(db, user_id):
    rooms = db.execute("""
        SELECT rp.room_id, r.host_user_id FROM room_players rp
        JOIN rooms r ON rp.room_id = r.id
        WHERE rp.user_id=? AND r.status='waiting'
    """, (user_id,)).fetchall()

    for r in rooms:
        db.execute("DELETE FROM room_players WHERE room_id=? AND user_id=?",
                  (r['room_id'], user_id))
        if r['host_user_id'] == user_id:
            remaining = db.execute("SELECT user_id FROM room_players WHERE room_id=? LIMIT 1",
                                  (r['room_id'],)).fetchone()
            if remaining:
                db.execute("UPDATE rooms SET host_user_id=? WHERE id=?",
                          (remaining['user_id'], r['room_id']))
            else:
                db.execute("DELETE FROM rooms WHERE id=?", (r['room_id'],))
    db.commit()

def start_game(db, room_id, players):
    db.execute("UPDATE rooms SET status='in_progress' WHERE id=?", (room_id,))

    player_seats = []
    for i, p in enumerate(players):
        seat = i + 1
        db.execute("UPDATE room_players SET seat_position=? WHERE id=?", (seat, p['id']))
        player_seats.append((p['user_id'], seat))

    button_seat = random.randint(1, len(players))
    deal_hand(db, room_id, 1, button_seat, player_seats)
    db.commit()

# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------

# Serve frontend
@app.route('/')
def serve_index():
    return send_from_directory(app.static_folder, 'index.html')

# Health check
@app.route('/health')
def health():
    return jsonify({"status": "ok"})

# Auth routes (no token required)
@app.route('/api/register', methods=['POST'])
def api_register():
    db = get_db()
    body = request.get_json(force=True, silent=True) or {}
    username = body.get('username', '').strip()
    password = body.get('password', '')
    if not username or not password:
        return jsonify({"error": "Username and password required"}), 400
    if len(username) < 2 or len(username) > 20:
        return jsonify({"error": "Username must be 2-20 characters"}), 400
    if len(password) < 3:
        return jsonify({"error": "Password must be at least 3 characters"}), 400

    existing = db.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if existing:
        return jsonify({"error": "Username already taken"}), 400

    pw_hash = hash_password(password)
    cur = db.execute("INSERT INTO users (username, password_hash) VALUES (?, ?)",
                    (username, pw_hash))
    db.commit()
    uid = cur.lastrowid
    return jsonify({"token": make_token(uid), "user_id": uid, "username": username}), 201

@app.route('/api/login', methods=['POST'])
def api_login():
    db = get_db()
    body = request.get_json(force=True, silent=True) or {}
    username = body.get('username', '').strip()
    password = body.get('password', '')
    user = db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if not user or user['password_hash'] != hash_password(password):
        return jsonify({"error": "Invalid username or password"}), 401
    return jsonify({"token": make_token(user['id']), "user_id": user['id'], "username": user['username']})

# Protected routes
@app.route('/api/me')
def api_me():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401
    user = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not user:
        return jsonify({"error": "User not found"}), 404
    return jsonify({
        "user_id": user['id'],
        "username": user['username'],
        "total_points_won": user['total_points_won'],
        "total_points_lost": user['total_points_lost'],
        "net_points": user['total_points_won'] - user['total_points_lost'],
        "games_played": user['games_played']
    })

@app.route('/api/rooms', methods=['GET'])
def api_list_rooms():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401
    rooms = db.execute("""
        SELECT r.*, u.username as host_name,
        (SELECT COUNT(*) FROM room_players WHERE room_id=r.id) as player_count
        FROM rooms r
        LEFT JOIN users u ON r.host_user_id = u.id
        WHERE r.status = 'waiting'
        ORDER BY r.created_at DESC
    """).fetchall()

    result = []
    for r in rooms:
        result.append({
            "id": r['id'], "room_code": r['room_code'],
            "host": r['host_name'], "point_value": r['point_value'],
            "player_count": r['player_count'], "max_players": r['max_players']
        })
    return jsonify(result)

@app.route('/api/rooms', methods=['POST'])
def api_create_room():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401
    body = request.get_json(force=True, silent=True) or {}

    leave_current_room(db, uid)

    point_value = body.get('point_value', 1.0)
    max_players = body.get('max_players', 4)
    max_players = max(2, min(6, int(max_players)))

    code = generate_room_code()
    while db.execute("SELECT id FROM rooms WHERE room_code=?", (code,)).fetchone():
        code = generate_room_code()

    cur = db.execute("""
        INSERT INTO rooms (room_code, host_user_id, point_value, max_players)
        VALUES (?, ?, ?, ?)
    """, (code, uid, point_value, max_players))
    room_id = cur.lastrowid

    db.execute("""
        INSERT INTO room_players (room_id, user_id, seat_position, is_ready)
        VALUES (?, ?, 1, 0)
    """, (room_id, uid))
    db.commit()

    return jsonify({"room_id": room_id, "room_code": code}), 201

@app.route('/api/rooms/join', methods=['POST'])
def api_join_room():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401
    body = request.get_json(force=True, silent=True) or {}
    code = body.get('room_code', '').strip().upper()
    room = db.execute("SELECT * FROM rooms WHERE room_code=? AND status='waiting'", (code,)).fetchone()
    if not room:
        return jsonify({"error": "Room not found or game already started"}), 400

    player_count = db.execute("SELECT COUNT(*) as c FROM room_players WHERE room_id=?",
                              (room['id'],)).fetchone()['c']
    if player_count >= room['max_players']:
        return jsonify({"error": "Room is full"}), 400

    existing = db.execute("SELECT id FROM room_players WHERE room_id=? AND user_id=?",
                         (room['id'], uid)).fetchone()
    if existing:
        return jsonify({"room_id": room['id'], "room_code": code})

    leave_current_room(db, uid)

    seat = player_count + 1
    db.execute("""
        INSERT INTO room_players (room_id, user_id, seat_position)
        VALUES (?, ?, ?)
    """, (room['id'], uid, seat))
    db.commit()

    return jsonify({"room_id": room['id'], "room_code": code})

@app.route('/api/rooms/leave', methods=['POST'])
def api_leave_room():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401

    # Handle leaving a waiting room
    leave_current_room(db, uid)

    # Handle leaving an in-progress game
    active_rp = db.execute("""
        SELECT rp.room_id, rp.seat_position FROM room_players rp
        JOIN rooms r ON rp.room_id = r.id
        WHERE rp.user_id=? AND r.status='in_progress'
    """, (uid,)).fetchone()

    if active_rp:
        room_id = active_rp['room_id']
        leaving_seat = active_rp['seat_position']

        # Get the latest hand
        hand = db.execute("""
            SELECT * FROM game_hands WHERE room_id=?
            ORDER BY hand_number DESC LIMIT 1
        """, (room_id,)).fetchone()

        if hand and hand['state'] in ('PLAYING', 'FINAL_TURNS'):
            # Mark the leaving player as disqualified in the current hand
            db.execute("""
                UPDATE player_hands SET is_disqualified=1
                WHERE game_hand_id=? AND user_id=?
            """, (hand['id'], uid))

            # Remove from room_players
            db.execute("DELETE FROM room_players WHERE room_id=? AND user_id=?",
                      (room_id, uid))

            # Check how many non-disqualified players remain
            remaining = db.execute("""
                SELECT COUNT(*) as cnt FROM player_hands
                WHERE game_hand_id=? AND is_disqualified=0
            """, (hand['id'],)).fetchone()['cnt']

            if remaining <= 1:
                # Only one player left — finish the hand immediately
                finish_hand(db, hand['id'])
            elif hand['current_turn_seat'] == leaving_seat:
                # It was the leaving player's turn — advance to next player
                # Clear any pending drawn card
                db.execute("""
                    UPDATE game_hands SET pending_drawn_card=NULL WHERE id=?
                """, (hand['id'],))
                all_ph = db.execute("""
                    SELECT seat_position FROM player_hands
                    WHERE game_hand_id=? AND is_disqualified=0
                    ORDER BY seat_position
                """, (hand['id'],)).fetchall()
                active_seats = [p['seat_position'] for p in all_ph]

                if hand['state'] == 'FINAL_TURNS':
                    # Remove leaving seat from final turn queue if present
                    fq = json.loads(hand['final_turn_queue']) if hand['final_turn_queue'] else []
                    fq = [s for s in fq if s != leaving_seat]
                    if len(fq) == 0:
                        finish_hand(db, hand['id'])
                    else:
                        next_seat = fq.pop(0)
                        db.execute("""
                            UPDATE game_hands SET current_turn_seat=?, final_turn_queue=?
                            WHERE id=?
                        """, (next_seat, json.dumps(fq), hand['id']))
                else:
                    # PLAYING state — find the next active seat in turn order
                    num_players_total = db.execute("""
                        SELECT COUNT(*) as cnt FROM player_hands WHERE game_hand_id=?
                    """, (hand['id'],)).fetchone()['cnt']
                    turn_order = get_turn_order(hand['button_seat'], num_players_total)
                    # Find next non-disqualified seat
                    if leaving_seat in turn_order:
                        idx = turn_order.index(leaving_seat)
                        for i in range(1, len(turn_order)):
                            candidate = turn_order[(idx + i) % len(turn_order)]
                            if candidate in active_seats:
                                db.execute("""
                                    UPDATE game_hands SET current_turn_seat=? WHERE id=?
                                """, (candidate, hand['id']))
                                break
                    elif active_seats:
                        db.execute("""
                            UPDATE game_hands SET current_turn_seat=? WHERE id=?
                        """, (active_seats[0], hand['id']))

            db.commit()

            # If only one player left in room_players, set room to finished
            remaining_room = db.execute("""
                SELECT COUNT(*) as cnt FROM room_players WHERE room_id=?
            """, (room_id,)).fetchone()['cnt']
            if remaining_room <= 1:
                db.execute("UPDATE rooms SET status='finished' WHERE id=?", (room_id,))
                db.commit()

        elif hand and hand['state'] == 'SCORING':
            # Game is in scoring — just remove and finish
            db.execute("DELETE FROM room_players WHERE room_id=? AND user_id=?",
                      (room_id, uid))
            remaining_room = db.execute("""
                SELECT COUNT(*) as cnt FROM room_players WHERE room_id=?
            """, (room_id,)).fetchone()['cnt']
            if remaining_room <= 1:
                db.execute("UPDATE rooms SET status='finished' WHERE id=?", (room_id,))
            db.commit()
        else:
            # No active hand or unknown state — just remove
            db.execute("DELETE FROM room_players WHERE room_id=? AND user_id=?",
                      (room_id, uid))
            db.commit()

    return jsonify({"ok": True})

@app.route('/api/rooms/ready', methods=['POST'])
def api_ready():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401

    rp = db.execute("""
        SELECT rp.*, r.status, r.id as room_id, r.host_user_id, r.max_players
        FROM room_players rp
        JOIN rooms r ON rp.room_id = r.id
        WHERE rp.user_id=? AND r.status='waiting'
    """, (uid,)).fetchone()

    if not rp:
        return jsonify({"error": "Not in a room"}), 400

    new_ready = 0 if rp['is_ready'] else 1
    db.execute("UPDATE room_players SET is_ready=? WHERE id=?", (new_ready, rp['id']))
    db.commit()

    players = db.execute("SELECT * FROM room_players WHERE room_id=?", (rp['room_id'],)).fetchall()
    all_ready = all(p['is_ready'] or (p['user_id'] == uid and new_ready) for p in players)

    if all_ready and len(players) >= 2:
        start_game(db, rp['room_id'], players)

    return jsonify({"is_ready": bool(new_ready)})

@app.route('/api/room-state')
def api_room_state():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401

    rp = db.execute("""
        SELECT rp.*, r.room_code, r.status, r.point_value, r.max_players, r.host_user_id
        FROM room_players rp
        JOIN rooms r ON rp.room_id = r.id
        WHERE rp.user_id=?
        ORDER BY rp.joined_at DESC LIMIT 1
    """, (uid,)).fetchone()

    if not rp:
        return jsonify({"error": "Not in a room"}), 404

    players = db.execute("""
        SELECT rp.*, u.username FROM room_players rp
        JOIN users u ON rp.user_id = u.id
        WHERE rp.room_id=?
        ORDER BY rp.seat_position
    """, (rp['room_id'],)).fetchall()

    player_list = [{
        'user_id': p['user_id'], 'username': p['username'],
        'seat': p['seat_position'], 'is_ready': bool(p['is_ready']),
        'is_host': p['user_id'] == rp['host_user_id']
    } for p in players]

    return jsonify({
        'room_id': rp['room_id'], 'room_code': rp['room_code'],
        'status': rp['status'], 'point_value': rp['point_value'],
        'max_players': rp['max_players'], 'host_user_id': rp['host_user_id'],
        'is_host': uid == rp['host_user_id'],
        'players': player_list, 'my_seat': rp['seat_position']
    })

@app.route('/api/game-state')
def api_game_state():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401

    rp = db.execute("""
        SELECT rp.room_id FROM room_players rp
        JOIN rooms r ON rp.room_id = r.id
        WHERE rp.user_id=? AND r.status='in_progress'
        ORDER BY rp.joined_at DESC LIMIT 1
    """, (uid,)).fetchone()

    if not rp:
        # Check if user is in a room that just finished (e.g. other players left)
        finished_rp = db.execute("""
            SELECT rp.room_id FROM room_players rp
            JOIN rooms r ON rp.room_id = r.id
            WHERE rp.user_id=? AND r.status='finished'
            ORDER BY rp.joined_at DESC LIMIT 1
        """, (uid,)).fetchone()
        if finished_rp:
            # Check if this player is the only one left (others left mid-game)
            remaining = db.execute("""
                SELECT COUNT(*) as cnt FROM room_players WHERE room_id=?
            """, (finished_rp['room_id'],)).fetchone()['cnt']
            # Clean up: remove the player from the finished room
            db.execute("DELETE FROM room_players WHERE room_id=? AND user_id=?",
                      (finished_rp['room_id'], uid))
            db.commit()
            if remaining <= 1:
                return jsonify({"game_over_reason": "not_enough_players"})
        return jsonify({"error": "Not in an active game"}), 404

    hand = db.execute("""
        SELECT id FROM game_hands WHERE room_id=?
        ORDER BY hand_number DESC LIMIT 1
    """, (rp['room_id'],)).fetchone()

    if not hand:
        return jsonify({"error": "No active hand"}), 404

    state = sanitize_game_state(db, hand['id'], uid)
    return jsonify(state)

@app.route('/api/draw', methods=['POST'])
def api_draw():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401

    rp = db.execute("""
        SELECT rp.room_id, rp.seat_position FROM room_players rp
        JOIN rooms r ON rp.room_id = r.id
        WHERE rp.user_id=? AND r.status='in_progress'
    """, (uid,)).fetchone()

    if not rp:
        return jsonify({"error": "Not in an active game"}), 400

    hand = db.execute("""
        SELECT * FROM game_hands WHERE room_id=?
        ORDER BY hand_number DESC LIMIT 1
    """, (rp['room_id'],)).fetchone()

    if not hand:
        return jsonify({"error": "No active hand"}), 400

    if hand['state'] not in ('PLAYING', 'FINAL_TURNS'):
        return jsonify({"error": "Cannot draw right now"}), 400

    if hand['current_turn_seat'] != rp['seat_position']:
        return jsonify({"error": "Not your turn"}), 400

    if hand['pending_drawn_card']:
        drawn_card = json.loads(hand['pending_drawn_card'])
        return jsonify({'ok': True, 'drawn_card': drawn_card})

    deck = json.loads(hand['deck'])

    if len(deck) == 0:
        finish_hand(db, hand['id'])
        return jsonify({'ok': True, 'deck_empty': True})

    drawn_card = deck.pop(0)

    db.execute("""
        UPDATE game_hands SET deck=?, pending_drawn_card=? WHERE id=?
    """, (json.dumps(deck), json.dumps(drawn_card), hand['id']))
    db.commit()

    return jsonify({'ok': True, 'drawn_card': drawn_card})

@app.route('/api/action', methods=['POST'])
def api_action():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401

    body = request.get_json(force=True, silent=True) or {}
    action_type = body.get('type')
    if action_type not in ('draw_replace', 'draw_burn_reveal'):
        return jsonify({"error": "Invalid action type"}), 400

    rp = db.execute("""
        SELECT rp.room_id, rp.seat_position FROM room_players rp
        JOIN rooms r ON rp.room_id = r.id
        WHERE rp.user_id=? AND r.status='in_progress'
    """, (uid,)).fetchone()

    if not rp:
        return jsonify({"error": "Not in an active game"}), 400

    hand = db.execute("""
        SELECT * FROM game_hands WHERE room_id=?
        ORDER BY hand_number DESC LIMIT 1
    """, (rp['room_id'],)).fetchone()

    if not hand:
        return jsonify({"error": "No active hand"}), 400

    if hand['state'] not in ('PLAYING', 'FINAL_TURNS'):
        return jsonify({"error": "Cannot act right now"}), 400

    if hand['current_turn_seat'] != rp['seat_position']:
        return jsonify({"error": "Not your turn"}), 400

    ph = db.execute("""
        SELECT * FROM player_hands WHERE game_hand_id=? AND user_id=?
    """, (hand['id'], uid)).fetchone()

    cards = json.loads(ph['cards'])

    if not hand['pending_drawn_card']:
        return jsonify({"error": "Must draw a card first"}), 400

    drawn_card = json.loads(hand['pending_drawn_card'])

    username = db.execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone()['username']

    response_data = {
        'ok': True,
        'drawn_card': drawn_card,
        'burned_card': None
    }

    num_players = db.execute(
        "SELECT COUNT(*) as c FROM player_hands WHERE game_hand_id=?",
        (hand['id'],)
    ).fetchone()['c']

    if action_type == 'draw_replace':
        target_idx = body.get('target_card_index')
        if target_idx is None or target_idx < 0 or target_idx >= 6:
            return jsonify({"error": "Invalid target card index"}), 400

        old_card = cards[target_idx]
        was_face_down = not old_card.get('face_up', False)

        new_card = {
            'suit': drawn_card['suit'],
            'rank': drawn_card['rank'],
            'face_up': True
        }
        cards[target_idx] = new_card

        if was_face_down:
            response_data['burned_card'] = {
                'suit': old_card['suit'],
                'rank': old_card['rank']
            }

        last_action = f"{username} drew {drawn_card['rank']}{suit_symbol(drawn_card['suit'])} and replaced card {target_idx + 1}"

        discard_card = {'suit': old_card['suit'], 'rank': old_card['rank']}

        db.execute("UPDATE player_hands SET cards=? WHERE id=?",
                  (json.dumps(cards), ph['id']))
        db.execute("""
            UPDATE game_hands SET last_drawn_card=?, last_action=?, pending_drawn_card=NULL
            WHERE id=?
        """, (json.dumps(discard_card), last_action, hand['id']))

        advance_turn(db, hand['id'], rp['seat_position'], num_players, hand['state'])

    elif action_type == 'draw_burn_reveal':
        reveal_idx = body.get('reveal_card_index')

        last_action = f"{username} drew {drawn_card['rank']}{suit_symbol(drawn_card['suit'])} and burned it"

        if reveal_idx is not None and 0 <= reveal_idx < 6:
            if not cards[reveal_idx].get('face_up', False):
                cards[reveal_idx]['face_up'] = True
                last_action += f", revealed {cards[reveal_idx]['rank']}{suit_symbol(cards[reveal_idx]['suit'])}"
                db.execute("UPDATE player_hands SET cards=? WHERE id=?",
                          (json.dumps(cards), ph['id']))

        db.execute("""
            UPDATE game_hands SET last_drawn_card=?, last_action=?, pending_drawn_card=NULL
            WHERE id=?
        """, (json.dumps(drawn_card), last_action, hand['id']))

        advance_turn(db, hand['id'], rp['seat_position'], num_players, hand['state'])

    return jsonify(response_data)

@app.route('/api/next-hand', methods=['POST'])
def api_next_hand():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401

    rp = db.execute("""
        SELECT rp.room_id FROM room_players rp
        JOIN rooms r ON rp.room_id = r.id
        WHERE rp.user_id=? AND r.status='in_progress'
    """, (uid,)).fetchone()

    if not rp:
        return jsonify({"error": "Not in an active game"}), 400

    room_id = rp['room_id']

    db.execute("""
        INSERT OR IGNORE INTO next_hand_ready (room_id, user_id) VALUES (?, ?)
    """, (room_id, uid))
    db.commit()

    total = db.execute("SELECT COUNT(*) as c FROM room_players WHERE room_id=?",
                      (room_id,)).fetchone()['c']
    ready = db.execute("SELECT COUNT(*) as c FROM next_hand_ready WHERE room_id=?",
                      (room_id,)).fetchone()['c']

    if ready >= total:
        db.execute("DELETE FROM next_hand_ready WHERE room_id=?", (room_id,))

        last_hand = db.execute("""
            SELECT * FROM game_hands WHERE room_id=?
            ORDER BY hand_number DESC LIMIT 1
        """, (room_id,)).fetchone()

        players = db.execute("""
            SELECT user_id, seat_position FROM room_players WHERE room_id=?
            ORDER BY seat_position
        """, (room_id,)).fetchall()

        player_seats = [(p['user_id'], p['seat_position']) for p in players]
        num_players = len(player_seats)

        old_button = last_hand['button_seat']
        new_button = old_button % num_players + 1

        new_hand_num = last_hand['hand_number'] + 1
        deal_hand(db, room_id, new_hand_num, new_button, player_seats)
        db.commit()

    return jsonify({"ok": True, "all_ready": ready >= total})

@app.route('/api/rooms/end-game', methods=['POST'])
def api_end_game():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401

    # Find the user's active room
    rp = db.execute("""
        SELECT rp.room_id FROM room_players rp
        JOIN rooms r ON rp.room_id = r.id
        WHERE rp.user_id=? AND r.status='in_progress'
        ORDER BY rp.joined_at DESC LIMIT 1
    """, (uid,)).fetchone()

    if rp:
        db.execute("UPDATE rooms SET status='finished' WHERE id=?", (rp['room_id'],))
        db.commit()

    return jsonify({"ok": True})


@app.route('/api/change-password', methods=['POST'])
def api_change_password():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401

    body = request.get_json(force=True, silent=True) or {}
    current_password = body.get('current_password', '')
    new_password = body.get('new_password', '')

    if not current_password or not new_password:
        return jsonify({"error": "Both current and new password are required"}), 400

    if len(new_password) < 3:
        return jsonify({"error": "New password must be at least 3 characters"}), 400

    user = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not user or user['password_hash'] != hash_password(current_password):
        return jsonify({"error": "Current password is incorrect"}), 400

    db.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(new_password), uid))
    db.commit()
    return jsonify({"ok": True})


@app.route('/api/delete-account', methods=['DELETE'])
def api_delete_account():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401

    body = request.get_json(force=True, silent=True) or {}
    password = body.get('password', '')

    if not password:
        return jsonify({"error": "Password is required to delete account"}), 400

    user = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not user or user['password_hash'] != hash_password(password):
        return jsonify({"error": "Incorrect password"}), 400

    # Remove from room_players
    db.execute("DELETE FROM room_players WHERE user_id=?", (uid,))

    # Delete rooms hosted by user that have no other players
    hosted_rooms = db.execute("SELECT id FROM rooms WHERE host_user_id=?", (uid,)).fetchall()
    for room in hosted_rooms:
        remaining = db.execute("SELECT COUNT(*) as c FROM room_players WHERE room_id=?",
                               (room['id'],)).fetchone()['c']
        if remaining == 0:
            db.execute("DELETE FROM rooms WHERE id=?", (room['id'],))
        else:
            # Transfer host to another player
            new_host = db.execute("SELECT user_id FROM room_players WHERE room_id=? LIMIT 1",
                                  (room['id'],)).fetchone()
            if new_host:
                db.execute("UPDATE rooms SET host_user_id=? WHERE id=?",
                           (new_host['user_id'], room['id']))

    # Delete the user
    db.execute("DELETE FROM users WHERE id=?", (uid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------
@app.route('/api/chat', methods=['POST'])
def api_send_chat():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401

    body = request.get_json(force=True, silent=True) or {}
    message = body.get('message', '').strip()
    if not message:
        return jsonify({"error": "Empty message"}), 400
    if len(message) > 200:
        return jsonify({"error": "Message too long (200 char max)"}), 400

    # Find the player's active room
    rp = db.execute("""
        SELECT rp.room_id FROM room_players rp
        JOIN rooms r ON rp.room_id = r.id
        WHERE rp.user_id=? AND r.status='in_progress'
        ORDER BY rp.joined_at DESC LIMIT 1
    """, (uid,)).fetchone()
    if not rp:
        return jsonify({"error": "Not in an active game"}), 400

    user = db.execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone()
    username = user['username'] if user else 'Unknown'

    db.execute("""
        INSERT INTO chat_messages (room_id, user_id, username, message)
        VALUES (?, ?, ?, ?)
    """, (rp['room_id'], uid, username, message))
    db.commit()
    return jsonify({"ok": True}), 201


@app.route('/api/chat')
def api_get_chat():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401

    # Find the player's active room
    rp = db.execute("""
        SELECT rp.room_id FROM room_players rp
        JOIN rooms r ON rp.room_id = r.id
        WHERE rp.user_id=? AND r.status='in_progress'
        ORDER BY rp.joined_at DESC LIMIT 1
    """, (uid,)).fetchone()
    if not rp:
        return jsonify([])  # No active game, return empty

    # Optional: only return messages newer than a given ID
    since_id = request.args.get('since', 0, type=int)

    rows = db.execute("""
        SELECT id, user_id, username, message, created_at
        FROM chat_messages
        WHERE room_id=? AND id>?
        ORDER BY id ASC
        LIMIT 50
    """, (rp['room_id'], since_id)).fetchall()

    return jsonify([{
        'id': r['id'],
        'user_id': r['user_id'],
        'username': r['username'],
        'message': r['message'],
        'created_at': r['created_at']
    } for r in rows])


@app.route('/api/stats')
def api_stats():
    db = get_db()
    uid = require_auth()
    if uid is None:
        return jsonify({"error": "Unauthorized"}), 401
    user = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not user:
        return jsonify({"error": "User not found"}), 404
    return jsonify({
        "username": user['username'],
        "total_points_won": user['total_points_won'],
        "total_points_lost": user['total_points_lost'],
        "net_points": user['total_points_won'] - user['total_points_lost'],
        "games_played": user['games_played']
    })

@app.route('/api/leaderboard')
def api_leaderboard():
    db = get_db()
    # No auth required for leaderboard (but original had it, keeping token optional)
    rows = db.execute("""
        SELECT username, total_points_won, total_points_lost, games_played,
               (total_points_won - total_points_lost) as net_points
        FROM users
        WHERE games_played > 0
        ORDER BY net_points DESC, total_points_won DESC
        LIMIT 20
    """).fetchall()
    result = []
    for i, r in enumerate(rows):
        result.append({
            'rank': i + 1,
            'username': r['username'],
            'net_points': r['net_points'],
            'games_played': r['games_played'],
            'points_won': r['total_points_won'],
            'points_lost': r['total_points_lost']
        })
    return jsonify(result)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
# Always init DB on import (needed for gunicorn which doesn't run __main__)
logger.info("Initializing database...")
init_db()
logger.info(f"SixJax Poker server ready. DB at {DB_PATH}")

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, debug=False)
