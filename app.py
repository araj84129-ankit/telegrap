import os
import re
import uuid
from datetime import datetime, timezone, timedelta
from functools import wraps

from flask import (
    Flask,
    jsonify,
    render_template,
    request,
    session,
    send_from_directory,
)
from flask_sqlalchemy import SQLAlchemy
from flask_socketio import SocketIO, emit, join_room
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from werkzeug.middleware.proxy_fix import ProxyFix


# ============================================================
# APP CONFIGURATION
# ============================================================

BASE_DIR = os.path.abspath(os.path.dirname(__file__))

UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__)

# Render / reverse proxy support
app.wsgi_app = ProxyFix(
    app.wsgi_app,
    x_for=1,
    x_proto=1,
    x_host=1,
    x_prefix=1,
)

# IMPORTANT:
# Production me SECRET_KEY environment variable me set karo.
app.config["SECRET_KEY"] = os.environ.get(
    "SECRET_KEY",
    "change-this-secret-key-in-production",
)

# Render normally provides RENDER=true.
IS_PRODUCTION = str(
    os.environ.get("RENDER")
    or os.environ.get("IS_PRODUCTION")
    or ""
).lower() in {"1", "true", "yes", "on"}

app.config["SESSION_COOKIE_SAMESITE"] = (
    "None" if IS_PRODUCTION else "Lax"
)

app.config["SESSION_COOKIE_SECURE"] = IS_PRODUCTION
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_NAME"] = "telegrav_session"
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)

# SQLite
app.config["SQLALCHEMY_DATABASE_URI"] = (
    "sqlite:///" + os.path.join(BASE_DIR, "chatwave.db")
)

app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

# Maximum request/file size = 5 MB
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024

db = SQLAlchemy(app)

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="eventlet" if IS_PRODUCTION else "threading",
    logger=False,
    engineio_logger=False,
)


# ============================================================
# GLOBAL STATE
# ============================================================

# user_id -> set(socket session IDs)
connected_users = {}


# ============================================================
# HELPERS
# ============================================================

def utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso_time(value):
    if not value:
        return None
    return value.strftime("%Y-%m-%dT%H:%M:%S")


def normalize_username(value):
    return str(value or "").strip().lower()


def normalize_email(value):
    return str(value or "").strip().lower()


def normalize_phone(value):
    return re.sub(r"[^\d+]", "", str(value or "").strip())


def valid_username(username):
    return bool(
        re.fullmatch(r"[A-Za-z0-9_.]{3,30}", username)
    )


def valid_email(email):
    if not email:
        return True

    # Fixed email regex
    return bool(
        re.fullmatch(
            r"^[^@\s]+@[^@\s]+\.[^@\s]+$",
            email,
        )
    )


def valid_phone(phone):
    if not phone:
        return True

    digits = re.sub(r"\D", "", phone)

    return 7 <= len(digits) <= 15


def current_user():
    try:
        user_id = session.get("user_id")
    except Exception:
        user_id = None

    if not user_id:
        return None

    return db.session.get(User, user_id)


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = current_user()

        if not user:
            return jsonify({
                "error": "Login required."
            }), 401

        return fn(*args, **kwargs)

    return wrapper


def user_public(user):
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "profile_photo": user.profile_photo,
        "online": user.online_status,
        "last_seen": iso_time(user.last_seen),
    }


def room_for_user(user_id):
    return f"user:{user_id}"


def conversation_room(conversation_id):
    return f"conversation:{conversation_id}"


def conversation_has_user(conversation, user_id):
    if not conversation:
        return False

    return user_id in (
        conversation.user_one_id,
        conversation.user_two_id,
    )


def other_user(conversation, user_id):
    if not conversation:
        return None

    if conversation.user_one_id == user_id:
        return db.session.get(
            User,
            conversation.user_two_id,
        )

    return db.session.get(
        User,
        conversation.user_one_id,
    )


def emit_to_user(user_id, event, data):
    socket_ids = connected_users.get(
        user_id,
        set(),
    )

    for sid in list(socket_ids):
        socketio.emit(
            event,
            data,
            to=sid,
        )


def remove_socket_for_user(user_id, sid):
    sockets = connected_users.get(user_id)

    if not sockets:
        return

    sockets.discard(sid)

    if not sockets:
        connected_users.pop(user_id, None)


def get_or_create_conversation(user_a, user_b):
    low = min(user_a, user_b)
    high = max(user_a, user_b)

    conversation = (
        Conversation.query
        .filter_by(
            user_one_id=low,
            user_two_id=high,
        )
        .first()
    )

    if not conversation:
        conversation = Conversation(
            user_one_id=low,
            user_two_id=high,
            created_at=utc_now(),
        )

        db.session.add(conversation)

        try:
            db.session.commit()
        except Exception:
            db.session.rollback()

            conversation = (
                Conversation.query
                .filter_by(
                    user_one_id=low,
                    user_two_id=high,
                )
                .first()
            )

            if not conversation:
                raise

    return conversation


def get_call(call_id):
    try:
        return db.session.get(
            Call,
            int(call_id),
        )
    except (TypeError, ValueError):
        return None


def call_has_user(call, user_id):
    if not call:
        return False

    return user_id in (
        call.caller_id,
        call.receiver_id,
    )


def call_other_user_id(call, user_id):
    if call.caller_id == user_id:
        return call.receiver_id

    return call.caller_id


def message_public(message, include_reactions=True):
    reply_to = None

    if message.reply_to_id:
        parent = db.session.get(
            Message,
            message.reply_to_id,
        )

        # Only expose reply information if it belongs
        # to the same conversation.
        if (
            parent
            and parent.conversation_id == message.conversation_id
        ):
            sender = db.session.get(
                User,
                parent.sender_id,
            )

            reply_to = {
                "id": parent.id,
                "message": (
                    "🗑 Deleted message"
                    if parent.is_deleted
                    else parent.message
                ),
                "sender_name": (
                    sender.display_name
                    if sender
                    else "Unknown"
                ),
                "file_url": parent.file_url,
                "file_type": parent.file_type,
            }

    reactions = {}

    if include_reactions:
        rows = (
            Reaction.query
            .filter_by(message_id=message.id)
            .all()
        )

        for reaction in rows:
            reactions[reaction.emoji] = (
                reactions.get(reaction.emoji, 0) + 1
            )

    forwarded_from = None

    if message.forwarded_from_id:
        forwarded_user = db.session.get(
            User,
            message.forwarded_from_id,
        )

        if forwarded_user:
            forwarded_from = forwarded_user.display_name

    return {
        "id": message.id,
        "conversation_id": message.conversation_id,
        "sender_id": message.sender_id,
        "receiver_id": message.receiver_id,

        "message": (
            "🗑 This message was deleted"
            if message.is_deleted
            else message.message
        ),

        "is_deleted": message.is_deleted,
        "is_edited": message.is_edited,
        "edited_at": iso_time(message.edited_at),
        "is_pinned": message.is_pinned,

        "reply_to": reply_to,
        "forwarded_from": forwarded_from,

        "file_url": message.file_url,
        "file_name": message.file_name,
        "file_type": message.file_type,

        "reactions": reactions,

        "created_at": iso_time(message.created_at),
        "delivered_at": iso_time(message.delivered_at),
        "read_at": iso_time(message.read_at),
    }


# ============================================================
# DATABASE MODELS
# ============================================================

class User(db.Model):
    __tablename__ = "users"

    id = db.Column(
        db.Integer,
        primary_key=True,
    )

    username = db.Column(
        db.String(30),
        unique=True,
        nullable=False,
        index=True,
    )

    display_name = db.Column(
        db.String(80),
        nullable=False,
    )

    email = db.Column(
        db.String(255),
        unique=True,
        nullable=True,
        index=True,
    )

    phone = db.Column(
        db.String(30),
        unique=True,
        nullable=True,
        index=True,
    )

    password_hash = db.Column(
        db.String(255),
        nullable=False,
    )

    profile_photo = db.Column(
        db.String(500),
        nullable=True,
    )

    online_status = db.Column(
        db.Boolean,
        default=False,
        nullable=False,
    )

    last_seen = db.Column(
        db.DateTime,
        nullable=True,
    )

    created_at = db.Column(
        db.DateTime,
        default=utc_now,
        nullable=False,
    )


class Conversation(db.Model):
    __tablename__ = "conversations"

    id = db.Column(
        db.Integer,
        primary_key=True,
    )

    user_one_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id"),
        nullable=False,
    )

    user_two_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id"),
        nullable=False,
    )

    created_at = db.Column(
        db.DateTime,
        default=utc_now,
        nullable=False,
    )

    __table_args__ = (
        db.UniqueConstraint(
            "user_one_id",
            "user_two_id",
            name="unique_conversation_pair",
        ),
    )


class Message(db.Model):
    __tablename__ = "messages"

    id = db.Column(
        db.Integer,
        primary_key=True,
    )

    conversation_id = db.Column(
        db.Integer,
        db.ForeignKey("conversations.id"),
        nullable=False,
        index=True,
    )

    sender_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id"),
        nullable=False,
    )

    receiver_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id"),
        nullable=False,
    )

    message = db.Column(
        db.Text,
        nullable=False,
    )

    reply_to_id = db.Column(
        db.Integer,
        db.ForeignKey("messages.id"),
        nullable=True,
    )

    is_deleted = db.Column(
        db.Boolean,
        default=False,
        nullable=False,
    )

    is_edited = db.Column(
        db.Boolean,
        default=False,
        nullable=False,
    )

    edited_at = db.Column(
        db.DateTime,
        nullable=True,
    )

    is_pinned = db.Column(
        db.Boolean,
        default=False,
        nullable=False,
    )

    forwarded_from_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id"),
        nullable=True,
    )

    file_url = db.Column(
        db.String(500),
        nullable=True,
    )

    file_name = db.Column(
        db.String(255),
        nullable=True,
    )

    file_type = db.Column(
        db.String(50),
        nullable=True,
    )

    created_at = db.Column(
        db.DateTime,
        default=utc_now,
        nullable=False,
        index=True,
    )

    delivered_at = db.Column(
        db.DateTime,
        nullable=True,
    )

    read_at = db.Column(
        db.DateTime,
        nullable=True,
    )


class Reaction(db.Model):
    __tablename__ = "reactions"

    id = db.Column(
        db.Integer,
        primary_key=True,
    )

    message_id = db.Column(
        db.Integer,
        db.ForeignKey("messages.id"),
        nullable=False,
        index=True,
    )

    user_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id"),
        nullable=False,
    )

    emoji = db.Column(
        db.String(10),
        nullable=False,
    )

    __table_args__ = (
        db.UniqueConstraint(
            "message_id",
            "user_id",
            name="unique_reaction_per_user",
        ),
    )


class Call(db.Model):
    __tablename__ = "calls"

    id = db.Column(
        db.Integer,
        primary_key=True,
    )

    caller_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id"),
        nullable=False,
    )

    receiver_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id"),
        nullable=False,
    )

    call_type = db.Column(
        db.String(20),
        nullable=False,
    )

    status = db.Column(
        db.String(20),
        nullable=False,
        default="ringing",
    )

    started_at = db.Column(
        db.DateTime,
        nullable=True,
    )

    ended_at = db.Column(
        db.DateTime,
        nullable=True,
    )


# ============================================================
# DATABASE INITIALIZATION
# ============================================================

with app.app_context():
    db.create_all()


# ============================================================
# MAIN PAGE
# ============================================================

@app.route("/")
def index():
    return render_template("index.html")


# ============================================================
# AUTHENTICATION
# ============================================================

@app.post("/api/register")
def register():
    data = request.get_json(silent=True) or {}

    username = normalize_username(
        data.get("username", "")
    )

    display_name = str(
        data.get("display_name", "")
    ).strip()

    email = normalize_email(
        data.get("email", "")
    )

    phone = normalize_phone(
        data.get("phone", "")
    )

    password = str(
        data.get("password", "")
    )

    if not valid_username(username):
        return jsonify({
            "error": (
                "Username must contain 3-30 letters, "
                "numbers, _ or ."
            )
        }), 400

    if not display_name:
        return jsonify({
            "error": "Display name is required."
        }), 400

    if len(display_name) > 80:
        return jsonify({
            "error": "Display name is too long."
        }), 400

    if not email and not phone:
        return jsonify({
            "error": "Email or mobile is required."
        }), 400

    if email and not valid_email(email):
        return jsonify({
            "error": "Invalid email address."
        }), 400

    if phone and not valid_phone(phone):
        return jsonify({
            "error": "Invalid mobile number."
        }), 400

    if len(password) < 8:
        return jsonify({
            "error": "Password must be at least 8 characters."
        }), 400

    if User.query.filter_by(
        username=username
    ).first():
        return jsonify({
            "error": "Username already exists."
        }), 409

    if email and User.query.filter_by(
        email=email
    ).first():
        return jsonify({
            "error": "Email already exists."
        }), 409

    if phone and User.query.filter_by(
        phone=phone
    ).first():
        return jsonify({
            "error": "Mobile number already exists."
        }), 409

    now = utc_now()

    user = User(
        username=username,
        display_name=display_name,
        email=email or None,
        phone=phone or None,
        password_hash=generate_password_hash(password),
        online_status=True,
        last_seen=now,
        created_at=now,
    )

    db.session.add(user)
    db.session.commit()

    session.clear()
    session.permanent = True
    session["user_id"] = user.id

    return jsonify({
        "ok": True,
        "user": user_public(user),
    })


@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}

    identifier = str(
        data.get("identifier", "")
    ).strip()

    password = str(
        data.get("password", "")
    )

    if not identifier or not password:
        return jsonify({
            "error": (
                "Email/mobile/username and password "
                "are required."
            )
        }), 400

    normalized = identifier.lower()
    normalized_phone = normalize_phone(identifier)

    user = User.query.filter(
        db.or_(
            User.email == normalized,
            User.phone == normalized_phone,
            User.username == normalized,
        )
    ).first()

    if not user or not check_password_hash(
        user.password_hash,
        password,
    ):
        return jsonify({
            "error": "Invalid login details."
        }), 401

    user.online_status = True
    user.last_seen = utc_now()

    db.session.commit()

    session.clear()
    session.permanent = True
    session["user_id"] = user.id

    return jsonify({
        "ok": True,
        "user": user_public(user),
    })


@app.post("/api/logout")
@login_required
def logout():
    user = current_user()

    user_id = user.id

    user.online_status = False
    user.last_seen = utc_now()

    db.session.commit()

    emit_to_user(
        user_id,
        "presence:update",
        {
            "user_id": user_id,
            "online": False,
            "last_seen": iso_time(user.last_seen),
        },
    )

    # Remove all currently tracked sockets for this user.
    connected_users.pop(user_id, None)

    session.clear()

    return jsonify({
        "ok": True
    })


@app.get("/api/me")
@login_required
def me():
    user = current_user()

    return jsonify({
        "user": user_public(user)
    })


# ============================================================
# USER SEARCH
# ============================================================

@app.get("/api/users/search")
@login_required
def search_users():
    user = current_user()

    query = str(
        request.args.get("q", "")
    ).strip()

    if len(query) < 2:
        return jsonify({
            "users": []
        })

    search = query.lower()

    users = (
        User.query
        .filter(
            User.id != user.id,
            db.or_(
                User.username.ilike(
                    f"%{search}%"
                ),
                User.display_name.ilike(
                    f"%{query}%"
                ),
            ),
        )
        .order_by(
            User.username.asc()
        )
        .limit(20)
        .all()
    )

    return jsonify({
        "users": [
            user_public(u)
            for u in users
        ]
    })


# ============================================================
# CREATE / OPEN CHAT
# ============================================================

@app.post("/api/chats/<int:user_id>")
@login_required
def create_chat(user_id):
    me_user = current_user()

    if user_id == me_user.id:
        return jsonify({
            "error": "You cannot chat with yourself."
        }), 400

    target = db.session.get(
        User,
        user_id,
    )

    if not target:
        return jsonify({
            "error": "User not found."
        }), 404

    conversation = get_or_create_conversation(
        me_user.id,
        target.id,
    )

    return jsonify({
        "conversation_id": conversation.id,
        "user": user_public(target),
    })


# ============================================================
# CHAT LIST
# ============================================================

@app.get("/api/chats")
@login_required
def chats():
    me_user = current_user()

    conversations = (
        Conversation.query
        .filter(
            db.or_(
                Conversation.user_one_id == me_user.id,
                Conversation.user_two_id == me_user.id,
            )
        )
        .all()
    )

    result = []

    for conversation in conversations:
        target = other_user(
            conversation,
            me_user.id,
        )

        if not target:
            continue

        last_message = (
            Message.query
            .filter_by(
                conversation_id=conversation.id
            )
            .order_by(
                Message.id.desc()
            )
            .first()
        )

        unread_count = (
            Message.query
            .filter(
                Message.conversation_id == conversation.id,
                Message.receiver_id == me_user.id,
                Message.read_at.is_(None),
            )
            .count()
        )

        result.append({
            "conversation_id": conversation.id,
            "user": user_public(target),
            "last_message": (
                message_public(last_message)
                if last_message
                else None
            ),
            "unread_count": unread_count,
        })

    result.sort(
        key=lambda item: (
            item["last_message"]["created_at"]
            if item["last_message"]
            else ""
        ),
        reverse=True,
    )

    return jsonify({
        "chats": result
    })


# ============================================================
# MESSAGE HISTORY
# ============================================================

@app.get("/api/chats/<int:conversation_id>/messages")
@login_required
def get_messages(conversation_id):
    me_user = current_user()

    conversation = db.session.get(
        Conversation,
        conversation_id,
    )

    if not conversation:
        return jsonify({
            "error": "Conversation not found."
        }), 404

    if not conversation_has_user(
        conversation,
        me_user.id,
    ):
        return jsonify({
            "error": "You are not allowed to access this chat."
        }), 403

    try:
        limit = int(
            request.args.get(
                "limit",
                100,
            )
        )
    except (ValueError, TypeError):
        limit = 100

    limit = max(
        1,
        min(limit, 200),
    )

    messages = (
        Message.query
        .filter_by(
            conversation_id=conversation_id
        )
        .order_by(
            Message.id.desc()
        )
        .limit(limit)
        .all()
    )

    messages.reverse()

    now = utc_now()
    changed = False

    for message in messages:
        if (
            message.receiver_id == me_user.id
            and message.delivered_at is None
        ):
            message.delivered_at = now
            changed = True

        if (
            message.receiver_id == me_user.id
            and message.read_at is None
        ):
            message.read_at = now
            changed = True

    if changed:
        db.session.commit()

    return jsonify({
        "messages": [
            message_public(message)
            for message in messages
        ]
    })


# ============================================================
# PROFILE
# ============================================================

@app.post("/api/profile")
@login_required
def update_profile():
    user = current_user()

    display_name = str(
        request.form.get(
            "display_name",
            "",
        )
    ).strip()

    if not display_name:
        return jsonify({
            "error": "Display name is required."
        }), 400

    if len(display_name) > 80:
        return jsonify({
            "error": "Display name is too long."
        }), 400

    user.display_name = display_name

    photo = request.files.get(
        "profile_photo"
    )

    if photo and photo.filename:
        allowed = {
            "png",
            "jpg",
            "jpeg",
            "webp",
            "gif",
        }

        extension = (
            photo.filename
            .rsplit(".", 1)[-1]
            .lower()
            if "." in photo.filename
            else ""
        )

        if extension not in allowed:
            return jsonify({
                "error": (
                    "Only PNG, JPG, JPEG, "
                    "WEBP and GIF are allowed."
                )
            }), 400

        filename = (
            f"{uuid.uuid4().hex}.{extension}"
        )

        safe_name = secure_filename(filename)

        path = os.path.join(
            UPLOAD_DIR,
            safe_name,
        )

        photo.save(path)

        user.profile_photo = (
            f"/uploads/{safe_name}"
        )

    db.session.commit()

    return jsonify({
        "ok": True,
        "user": user_public(user),
    })


# ============================================================
# PROTECTED UPLOADS
# ============================================================

@app.get("/uploads/<path:filename>")
@login_required
def uploaded_file(filename):
    # Files are no longer publicly accessible.
    return send_from_directory(
        UPLOAD_DIR,
        filename,
    )


# ============================================================
# FILE / IMAGE UPLOAD
# ============================================================

ALLOWED_EXTENSIONS = {
    "png",
    "jpg",
    "jpeg",
    "webp",
    "gif",
    "mp4",
    "pdf",
    "doc",
    "docx",
    "zip",
    "txt",
}


def allowed_file(filename):
    return (
        "." in filename
        and filename.rsplit(
            ".",
            1,
        )[-1].lower()
        in ALLOWED_EXTENSIONS
    )


@app.post("/api/upload")
@login_required
def upload_file():
    if "file" not in request.files:
        return jsonify({
            "error": "No file provided."
        }), 400

    file = request.files["file"]

    if not file.filename:
        return jsonify({
            "error": "Empty filename."
        }), 400

    if not allowed_file(file.filename):
        return jsonify({
            "error": "File type not allowed."
        }), 400

    ext = (
        file.filename
        .rsplit(".", 1)[-1]
        .lower()
    )

    filename = (
        f"{uuid.uuid4().hex}.{ext}"
    )

    safe_name = secure_filename(filename)

    path = os.path.join(
        UPLOAD_DIR,
        safe_name,
    )

    file.save(path)

    mime = file.content_type or ""

    if mime.startswith("image/"):
        ftype = "image"

    elif mime.startswith("video/"):
        ftype = "video"

    else:
        ftype = "file"

    return jsonify({
        "ok": True,
        "file_url": f"/uploads/{safe_name}",
        "file_name": file.filename,
        "file_type": ftype,
    })


# ============================================================
# DELETE MESSAGE
# ============================================================

@app.delete("/api/messages/<int:message_id>")
@login_required
def delete_message(message_id):
    user = current_user()

    message = db.session.get(
        Message,
        message_id,
    )

    if not message:
        return jsonify({
            "error": "Message not found."
        }), 404

    if message.sender_id != user.id:
        return jsonify({
            "error": "Not allowed."
        }), 403

    message.is_deleted = True
    message.message = ""
    message.file_url = None
    message.file_name = None
    message.file_type = None

    db.session.commit()

    payload = {
        "message_id": message.id,
        "conversation_id": message.conversation_id,
    }

    emit_to_user(
        message.sender_id,
        "message:deleted",
        payload,
    )

    emit_to_user(
        message.receiver_id,
        "message:deleted",
        payload,
    )

    return jsonify({
        "ok": True
    })


# ============================================================
# EDIT MESSAGE
# ============================================================

@app.put("/api/messages/<int:message_id>")
@login_required
def edit_message(message_id):
    user = current_user()

    message = db.session.get(
        Message,
        message_id,
    )

    if not message:
        return jsonify({
            "error": "Message not found."
        }), 404

    if message.sender_id != user.id:
        return jsonify({
            "error": "Not allowed."
        }), 403

    if message.is_deleted:
        return jsonify({
            "error": "Cannot edit deleted message."
        }), 400

    data = request.get_json(
        silent=True
    ) or {}

    new_text = str(
        data.get("message", "")
    ).strip()

    if not new_text:
        return jsonify({
            "error": "Message cannot be empty."
        }), 400

    if len(new_text) > 5000:
        return jsonify({
            "error": "Message too long."
        }), 400

    message.message = new_text
    message.is_edited = True
    message.edited_at = utc_now()

    db.session.commit()

    payload = message_public(message)

    emit_to_user(
        message.sender_id,
        "message:edited",
        payload,
    )

    emit_to_user(
        message.receiver_id,
        "message:edited",
        payload,
    )

    return jsonify({
        "ok": True,
        "message": payload,
    })


# ============================================================
# PIN / UNPIN MESSAGE
# ============================================================

@app.post("/api/messages/<int:message_id>/pin")
@login_required
def pin_message(message_id):
    user = current_user()

    message = db.session.get(
        Message,
        message_id,
    )

    if not message:
        return jsonify({
            "error": "Message not found."
        }), 404

    conversation = db.session.get(
        Conversation,
        message.conversation_id,
    )

    if not conversation_has_user(
        conversation,
        user.id,
    ):
        return jsonify({
            "error": "Not allowed."
        }), 403

    message.is_pinned = not message.is_pinned

    db.session.commit()

    payload = {
        "message_id": message.id,
        "conversation_id": message.conversation_id,
        "is_pinned": message.is_pinned,
        "message_text": (
            "🗑 Deleted message"
            if message.is_deleted
            else message.message
        ),
    }

    emit_to_user(
        message.sender_id,
        "message:pinned",
        payload,
    )

    emit_to_user(
        message.receiver_id,
        "message:pinned",
        payload,
    )

    return jsonify({
        "ok": True,
        "is_pinned": message.is_pinned,
    })


# ============================================================
# FORWARD MESSAGE
# ============================================================

@app.post("/api/messages/<int:message_id>/forward")
@login_required
def forward_message(message_id):
    user = current_user()

    source = db.session.get(
        Message,
        message_id,
    )

    if not source or source.is_deleted:
        return jsonify({
            "error": "Message not found."
        }), 404

    # IMPORTANT:
    # User can only forward a message from a conversation
    # in which they are a participant.
    source_conversation = db.session.get(
        Conversation,
        source.conversation_id,
    )

    if not conversation_has_user(
        source_conversation,
        user.id,
    ):
        return jsonify({
            "error": "Not allowed."
        }), 403

    data = request.get_json(
        silent=True
    ) or {}

    try:
        receiver_id = int(
            data.get("receiver_id")
        )
    except (TypeError, ValueError):
        return jsonify({
            "error": "Invalid receiver."
        }), 400

    receiver = db.session.get(
        User,
        receiver_id,
    )

    if not receiver or receiver.id == user.id:
        return jsonify({
            "error": "Invalid receiver."
        }), 400

    conversation = get_or_create_conversation(
        user.id,
        receiver.id,
    )

    now = utc_now()

    forwarded = Message(
        conversation_id=conversation.id,
        sender_id=user.id,
        receiver_id=receiver.id,
        message=source.message,
        forwarded_from_id=source.sender_id,
        file_url=source.file_url,
        file_name=source.file_name,
        file_type=source.file_type,
        created_at=now,
    )

    if receiver.id in connected_users:
        forwarded.delivered_at = now

    db.session.add(forwarded)
    db.session.commit()

    payload = message_public(forwarded)

    emit_to_user(
        user.id,
        "message:new",
        payload,
    )

    emit_to_user(
        receiver.id,
        "message:new",
        payload,
    )

    return jsonify({
        "ok": True,
        "message": payload,
    })


# ============================================================
# EMOJI REACTION
# ============================================================

@app.post("/api/messages/<int:message_id>/react")
@login_required
def react_message(message_id):
    user = current_user()

    message = db.session.get(
        Message,
        message_id,
    )

    if not message or message.is_deleted:
        return jsonify({
            "error": "Message not found."
        }), 404

    conversation = db.session.get(
        Conversation,
        message.conversation_id,
    )

    if not conversation_has_user(
        conversation,
        user.id,
    ):
        return jsonify({
            "error": "Not allowed."
        }), 403

    data = request.get_json(
        silent=True
    ) or {}

    emoji = str(
        data.get("emoji", "")
    ).strip()

    if not emoji or len(emoji) > 10:
        return jsonify({
            "error": "Invalid emoji."
        }), 400

    existing = (
        Reaction.query
        .filter_by(
            message_id=message_id,
            user_id=user.id,
        )
        .first()
    )

    if existing:
        if existing.emoji == emoji:
            db.session.delete(existing)
        else:
            existing.emoji = emoji
    else:
        db.session.add(
            Reaction(
                message_id=message_id,
                user_id=user.id,
                emoji=emoji,
            )
        )

    db.session.commit()

    rows = (
        Reaction.query
        .filter_by(
            message_id=message_id
        )
        .all()
    )

    reactions = {}

    for reaction in rows:
        reactions[reaction.emoji] = (
            reactions.get(
                reaction.emoji,
                0,
            ) + 1
        )

    payload = {
        "message_id": message_id,
        "conversation_id": message.conversation_id,
        "reactions": reactions,
    }

    emit_to_user(
        message.sender_id,
        "message:reaction",
        payload,
    )

    emit_to_user(
        message.receiver_id,
        "message:reaction",
        payload,
    )

    return jsonify({
        "ok": True,
        "reactions": reactions,
    })


# ============================================================
# GET PINNED MESSAGES
# ============================================================

@app.get("/api/chats/<int:conversation_id>/pinned")
@login_required
def get_pinned(conversation_id):
    user = current_user()

    conversation = db.session.get(
        Conversation,
        conversation_id,
    )

    if not conversation:
        return jsonify({
            "error": "Not found."
        }), 404

    if not conversation_has_user(
        conversation,
        user.id,
    ):
        return jsonify({
            "error": "Not allowed."
        }), 403

    pinned = (
        Message.query
        .filter_by(
            conversation_id=conversation_id,
            is_pinned=True,
            is_deleted=False,
        )
        .order_by(
            Message.id.desc()
        )
        .all()
    )

    return jsonify({
        "messages": [
            message_public(message)
            for message in pinned
        ]
    })


# ============================================================
# SOCKET.IO CONNECTION
# ============================================================

@socketio.on("connect")
def socket_connect():
    user = current_user()

    if not user:
        emit(
            "server:error",
            {
                "error": "Login required."
            },
        )
        return

    sid = request.sid

    sockets = connected_users.setdefault(
        user.id,
        set(),
    )

    was_offline = not sockets

    sockets.add(sid)

    join_room(
        room_for_user(user.id)
    )

    user.online_status = True
    user.last_seen = utc_now()

    db.session.commit()

    if was_offline:
        socketio.emit(
            "presence:update",
            {
                "user_id": user.id,
                "online": True,
                "last_seen": iso_time(
                    user.last_seen
                ),
            },
        )


@socketio.on("disconnect")
def socket_disconnect():
    user = current_user()

    if not user:
        return

    sid = request.sid

    sockets = connected_users.get(
        user.id,
        set(),
    )

    sockets.discard(sid)

    if not sockets:
        connected_users.pop(
            user.id,
            None,
        )

        user.online_status = False
        user.last_seen = utc_now()

        db.session.commit()

        socketio.emit(
            "presence:update",
            {
                "user_id": user.id,
                "online": False,
                "last_seen": iso_time(
                    user.last_seen
                ),
            },
        )


# ============================================================
# REAL-TIME MESSAGE
# ============================================================

@socketio.on("chat:send")
def socket_send_message(data):
    user = current_user()

    if not user:
        emit(
            "server:error",
            {
                "error": "Login required."
            },
        )
        return

    data = data or {}

    try:
        receiver_id = int(
            data.get("receiver_id")
        )
    except (TypeError, ValueError):
        emit(
            "server:error",
            {
                "error": "Invalid receiver."
            },
        )
        return

    text = str(
        data.get("message", "")
    ).strip()

    file_url = data.get("file_url") or None
    file_name = data.get("file_name") or None
    file_type = data.get("file_type") or None

    if not text and not file_url:
        return

    if len(text) > 5000:
        emit(
            "server:error",
            {
                "error": "Message is too long."
            },
        )
        return

    receiver = db.session.get(
        User,
        receiver_id,
    )

    if not receiver:
        emit(
            "server:error",
            {
                "error": "User not found."
            },
        )
        return

    if receiver.id == user.id:
        emit(
            "server:error",
            {
                "error": (
                    "You cannot send a message "
                    "to yourself."
                )
            },
        )
        return

    conversation = get_or_create_conversation(
        user.id,
        receiver.id,
    )

    # Validate reply message.
    reply_to_id = None
    raw_reply = data.get("reply_to_id")

    if raw_reply:
        try:
            reply_to_id = int(raw_reply)
        except (TypeError, ValueError):
            reply_to_id = None

    if reply_to_id:
        parent = db.session.get(
            Message,
            reply_to_id,
        )

        if not parent:
            emit(
                "server:error",
                {
                    "error": "Reply message not found."
                },
            )
            return

        if parent.conversation_id != conversation.id:
            emit(
                "server:error",
                {
                    "error": "Invalid reply message."
                },
            )
            return

    now = utc_now()

    message = Message(
        conversation_id=conversation.id,
        sender_id=user.id,
        receiver_id=receiver.id,
        message=text,
        reply_to_id=reply_to_id,
        file_url=file_url,
        file_name=file_name,
        file_type=file_type,
        created_at=now,
    )

    if receiver.id in connected_users:
        message.delivered_at = now

    db.session.add(message)
    db.session.commit()

    payload = message_public(message)

    # Send to sender's current socket.
    emit(
        "message:new",
        payload,
        to=request.sid,
    )

    # Send to all receiver sockets.
    emit_to_user(
        receiver.id,
        "message:new",
        payload,
    )

    if message.delivered_at:
        emit(
            "message:status",
            {
                "conversation_id": conversation.id,
                "message_id": message.id,
                "status": "delivered",
                "delivered_at": iso_time(
                    message.delivered_at
                ),
            },
            to=request.sid,
        )


# ============================================================
# READ RECEIPTS
# ============================================================

@socketio.on("chat:read")
def socket_chat_read(data):
    user = current_user()

    if not user:
        return

    data = data or {}

    try:
        conversation_id = int(
            data.get("conversation_id")
        )
    except (TypeError, ValueError):
        return

    conversation = db.session.get(
        Conversation,
        conversation_id,
    )

    if not conversation:
        return

    if not conversation_has_user(
        conversation,
        user.id,
    ):
        return

    now = utc_now()

    messages = (
        Message.query
        .filter(
            Message.conversation_id == conversation_id,
            Message.receiver_id == user.id,
            Message.read_at.is_(None),
        )
        .all()
    )

    if not messages:
        return

    status_updates = []

    for message in messages:
        message.read_at = now

        if message.delivered_at is None:
            message.delivered_at = now

        status_updates.append({
            "conversation_id": conversation_id,
            "message_id": message.id,
            "status": "read",
            "delivered_at": iso_time(
                message.delivered_at
            ),
            "read_at": iso_time(
                message.read_at
            ),
            "sender_id": message.sender_id,
        })

    db.session.commit()

    # Send read status after commit.
    for update in status_updates:
        emit_to_user(
            update["sender_id"],
            "message:status",
            update,
        )


# ============================================================
# TYPING INDICATOR
# ============================================================

@socketio.on("typing:start")
def typing_start(data):
    user = current_user()

    if not user:
        return

    data = data or {}

    try:
        receiver_id = int(
            data.get("receiver_id")
        )
    except (TypeError, ValueError):
        return

    receiver = db.session.get(
        User,
        receiver_id,
    )

    if not receiver or receiver.id == user.id:
        return

    conversation = get_or_create_conversation(
        user.id,
        receiver.id,
    )

    emit_to_user(
        receiver.id,
        "typing:update",
        {
            "conversation_id": conversation.id,
            "user_id": user.id,
            "typing": True,
        },
    )


@socketio.on("typing:stop")
def typing_stop(data):
    user = current_user()

    if not user:
        return

    data = data or {}

    try:
        receiver_id = int(
            data.get("receiver_id")
        )
    except (TypeError, ValueError):
        return

    receiver = db.session.get(
        User,
        receiver_id,
    )

    if not receiver:
        return

    conversation = get_or_create_conversation(
        user.id,
        receiver.id,
    )

    emit_to_user(
        receiver.id,
        "typing:update",
        {
            "conversation_id": conversation.id,
            "user_id": user.id,
            "typing": False,
        },
    )


# ============================================================
# CALLS
# ============================================================

@socketio.on("call:start")
def call_start(data):
    user = current_user()

    if not user:
        emit(
            "server:error",
            {
                "error": "Login required."
            },
        )
        return

    data = data or {}

    try:
        receiver_id = int(
            data.get("receiver_id")
        )
    except (TypeError, ValueError):
        emit(
            "server:error",
            {
                "error": "Invalid receiver."
            },
        )
        return

    call_type = str(
        data.get(
            "call_type",
            "voice",
        )
    ).lower()

    if call_type not in {
        "voice",
        "video",
    }:
        emit(
            "server:error",
            {
                "error": "Invalid call type."
            },
        )
        return

    receiver = db.session.get(
        User,
        receiver_id,
    )

    if not receiver or receiver.id == user.id:
        emit(
            "server:error",
            {
                "error": "Invalid receiver."
            },
        )
        return

    # Do not create another call if one is already active.
    active_call = Call.query.filter(
        db.or_(
            db.and_(
                Call.caller_id == user.id,
                Call.receiver_id == receiver.id,
            ),
            db.and_(
                Call.caller_id == receiver.id,
                Call.receiver_id == user.id,
            ),
        ),
        Call.status.in_([
            "ringing",
            "accepted",
        ]),
    ).first()

    if active_call:
        emit(
            "server:error",
            {
                "error": "A call is already active."
            },
        )
        return

    call = Call(
        caller_id=user.id,
        receiver_id=receiver.id,
        call_type=call_type,
        status="ringing",
        started_at=None,
        ended_at=None,
    )

    db.session.add(call)
    db.session.commit()

    payload = {
        "call_id": call.id,
        "caller": user_public(user),
        "receiver": user_public(receiver),
        "call_type": call_type,
    }

    emit(
        "call:started",
        payload,
        to=request.sid,
    )

    emit_to_user(
        receiver.id,
        "call:incoming",
        payload,
    )


@socketio.on("call:accept")
def call_accept(data):
    user = current_user()

    if not user:
        return

    data = data or {}

    call = get_call(
        data.get("call_id")
    )

    if not call:
        return

    if call.receiver_id != user.id:
        return

    if call.status != "ringing":
        return

    call.status = "accepted"
    call.started_at = utc_now()

    db.session.commit()

    emit_to_user(
        call.caller_id,
        "call:accepted",
        {
            "call_id": call.id,
            "call_type": call.call_type,
        },
    )


@socketio.on("call:reject")
def call_reject(data):
    user = current_user()

    if not user:
        return

    data = data or {}

    call = get_call(
        data.get("call_id")
    )

    if not call:
        return

    if not call_has_user(
        call,
        user.id,
    ):
        return

    if call.status in {
        "ended",
        "rejected",
    }:
        return

    call.status = "rejected"
    call.ended_at = utc_now()

    db.session.commit()

    other_id = call_other_user_id(
        call,
        user.id,
    )

    emit_to_user(
        other_id,
        "call:rejected",
        {
            "call_id": call.id,
        },
    )


@socketio.on("call:end")
def call_end(data):
    user = current_user()

    if not user:
        return

    data = data or {}

    call = get_call(
        data.get("call_id")
    )

    if not call:
        return

    if not call_has_user(
        call,
        user.id,
    ):
        return

    if call.status in {
        "ended",
        "rejected",
    }:
        return

    call.status = "ended"
    call.ended_at = utc_now()

    db.session.commit()

    other_id = call_other_user_id(
        call,
        user.id,
    )

    emit_to_user(
        other_id,
        "call:ended",
        {
            "call_id": call.id,
        },
    )


# ============================================================
# WEBRTC SIGNALING
# ============================================================

def valid_signaling_call(call, user_id):
    if not call:
        return False

    if not call_has_user(
        call,
        user_id,
    ):
        return False

    if call.status != "accepted":
        return False

    return True


@socketio.on("webrtc:offer")
def webrtc_offer(data):
    user = current_user()

    if not user:
        return

    data = data or {}

    call = get_call(
        data.get("call_id")
    )

    if not valid_signaling_call(
        call,
        user.id,
    ):
        return

    offer = data.get("offer")

    if not offer:
        return

    other_id = call_other_user_id(
        call,
        user.id,
    )

    emit_to_user(
        other_id,
        "webrtc:offer",
        {
            "call_id": call.id,
            "offer": offer,
        },
    )


@socketio.on("webrtc:answer")
def webrtc_answer(data):
    user = current_user()

    if not user:
        return

    data = data or {}

    call = get_call(
        data.get("call_id")
    )

    if not valid_signaling_call(
        call,
        user.id,
    ):
        return

    answer = data.get("answer")

    if not answer:
        return

    other_id = call_other_user_id(
        call,
        user.id,
    )

    emit_to_user(
        other_id,
        "webrtc:answer",
        {
            "call_id": call.id,
            "answer": answer,
        },
    )


@socketio.on("webrtc:ice")
def webrtc_ice(data):
    user = current_user()

    if not user:
        return

    data = data or {}

    call = get_call(
        data.get("call_id")
    )

    if not valid_signaling_call(
        call,
        user.id,
    ):
        return

    candidate = data.get("candidate")

    if not candidate:
        return

    other_id = call_other_user_id(
        call,
        user.id,
    )

    emit_to_user(
        other_id,
        "webrtc:ice",
        {
            "call_id": call.id,
            "candidate": candidate,
        },
    )


# ============================================================
# ERROR HANDLERS
# ============================================================

@app.errorhandler(413)
def request_too_large(error):
    return jsonify({
        "error": "File/request is too large. Maximum size is 5 MB."
    }), 413


# ============================================================
# RUN SERVER
# ============================================================

if __name__ == "__main__":
    print()
    print("=" * 60)
    print("ChatWave server starting...")
    print("=" * 60)
    print("Local:   http://127.0.0.1:5000")
    print("Network: http://0.0.0.0:5000")
    print("Database: chatwave.db")
    print(
        "Production:",
        "YES" if IS_PRODUCTION else "NO",
    )
    print("=" * 60)
    print()

    socketio.run(
        app,
        host="0.0.0.0",
        port=int(
            os.environ.get(
                "PORT",
                5000,
            )
        ),
        debug=not IS_PRODUCTION,
        allow_unsafe_werkzeug=not IS_PRODUCTION,
    )
