"use strict";

/* =========================================================
   SHORT SELECTOR
========================================================= */
const $ = (sel) => document.querySelector(sel);

/* =========================================================
   STATE
========================================================= */
const state = {
    me: null,
    socket: null,
    chats: [],
    activeChat: null,
    messages: new Map(),
    typingTimer: null,
    typingActive: false,
    call: null,
    pc: null,
    localStream: null,
    pendingCandidates: [],
    reconnecting: false,
    replyTo: null,          // { id, message, sender_name }
    contextTarget: null,    // message id for context menu
    editTarget: null,       // message id being edited
};

/* =========================================================
   HELPERS
========================================================= */
function defaultAvatar(name = "?") {
    return (
        "https://ui-avatars.com/api/?name=" +
        encodeURIComponent(name) +
        "&background=e1e9f6&color=345&bold=true"
    );
}

function avatarUrl(user) {
    if (user?.profile_photo) return user.profile_photo;
    return defaultAvatar(user?.display_name || user?.username || "?");
}

function escapeHtml(v) {
    return String(v ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])
    );
}

function parseDate(v) {
    if (!v) return null;
    const t = String(v);
    return new Date(t.endsWith("Z") || t.includes("+") ? t : t + "Z");
}

function formatTime(v) {
    const d = parseDate(v);
    if (!d || isNaN(d)) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(v) {
    const d = parseDate(v);
    if (!d || isNaN(d)) return "";
    const now = new Date();
    const diff = Math.round(
        (new Date(now.getFullYear(), now.getMonth(), now.getDate()) -
            new Date(d.getFullYear(), d.getMonth(), d.getDate())) /
        86400000
    );
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

function lastSeenText(user) {
    if (user?.online) return "online";
    if (!user?.last_seen) return "offline";
    return "last seen " + formatDate(user.last_seen) + " " + formatTime(user.last_seen);
}

/* =========================================================
   TOAST
========================================================= */
function showToast(message, type = "info") {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    $("#toast-container").appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

/* =========================================================
   API
========================================================= */
async function api(url, options = {}) {
    const config = { credentials: "same-origin", ...options };
    const headers = {
        ...(config.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(config.headers || {}),
    };
    const response = await fetch(url, { ...config, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
}

/* =========================================================
   AUTH TABS
========================================================= */
function showAuth(tab) {
    $("#login-form").classList.toggle("hidden", tab !== "login");
    $("#register-form").classList.toggle("hidden", tab !== "register");
    document.querySelectorAll(".tab").forEach((b) => {
        b.classList.toggle("active", b.dataset.authTab === tab);
    });
}

document.querySelectorAll(".tab").forEach((b) => {
    b.addEventListener("click", () => showAuth(b.dataset.authTab));
});

/* =========================================================
   LOGIN
========================================================= */
$("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
        const data = await api("/api/login", {
            method: "POST",
            body: JSON.stringify({
                identifier: $("#login-identifier").value.trim(),
                password: $("#login-password").value,
            }),
        });
        await enterApp(data.user);
    } catch (err) {
        showToast(err.message, "error");
    }
});

/* =========================================================
   REGISTER
========================================================= */
$("#register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
        const data = await api("/api/register", {
            method: "POST",
            body: JSON.stringify({
                username: $("#reg-username").value.trim(),
                display_name: $("#reg-display-name").value.trim(),
                email: $("#reg-email").value.trim(),
                phone: $("#reg-phone").value.trim(),
                password: $("#reg-password").value,
            }),
        });
        await enterApp(data.user);
    } catch (err) {
        showToast(err.message, "error");
    }
});

/* =========================================================
   ENTER APP
========================================================= */
async function enterApp(user) {
    state.me = user;
    $("#auth-view").classList.add("hidden");
    $("#app-view").classList.remove("hidden");
    connectSocket();
    await loadChats();
}

/* =========================================================
   SESSION CHECK
========================================================= */
async function checkSession() {
    try {
        const data = await api("/api/me");
        await enterApp(data.user);
    } catch {
        showAuth("login");
    }
}
checkSession();

/* =========================================================
   SOCKET
========================================================= */
function connectSocket() {
    if (state.socket) state.socket.disconnect();

    state.socket = io({
        transports: ["polling", "websocket"],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        timeout: 20000,
        forceNew: true,
    });

    state.socket.on("connect", () => {
        state.reconnecting = false;
        showToast("Connected", "success");
        if (state.activeChat) markRead();
    });

    state.socket.on("disconnect", () => {
        state.reconnecting = true;
        showToast("Connection lost. Reconnecting...", "error");
    });

    state.socket.on("connect_error", () => { state.reconnecting = true; });
    state.socket.on("message:new", handleNewMessage);
    state.socket.on("message:status", handleMessageStatus);
    state.socket.on("message:deleted", handleMessageDeleted);
    state.socket.on("message:edited", handleMessageEdited);
    state.socket.on("message:pinned", handleMessagePinned);
    state.socket.on("message:reaction", handleMessageReaction);
    state.socket.on("typing:update", handleTyping);
    state.socket.on("presence:update", handlePresence);
    state.socket.on("server:error", (d) => showToast(d?.error || "Server error", "error"));

    /* CALLS */
    state.socket.on("call:incoming", incomingCall);
    state.socket.on("call:started", (data) => {
        state.call = { ...data, direction: "outgoing" };
        openCallModal(data, "Calling…");
        $("#end-call").classList.remove("hidden");
    });
    state.socket.on("call:accepted", async (data) => {
        if (!state.call || state.call.call_id !== data.call_id) return;
        $("#call-status").textContent = "Connecting…";
        try {
            await createPeerConnection();
            await makeOffer();
        } catch (err) {
            showToast(err.message || "Could not start call.", "error");
            endCallLocal();
        }
    });
    state.socket.on("call:rejected", (data) => {
        if (state.call?.call_id === data.call_id) {
            $("#call-status").textContent = "Call rejected";
            setTimeout(endCallLocal, 1000);
        }
    });
    state.socket.on("call:ended", (data) => {
        if (state.call?.call_id === data.call_id) {
            $("#call-status").textContent = "Call ended";
            setTimeout(endCallLocal, 500);
        }
    });

    /* WEBRTC */
    state.socket.on("webrtc:offer", async (data) => {
        if (!state.call || state.call.call_id !== data.call_id) return;
        try {
            await createPeerConnection();
            await state.pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            await flushCandidates();
            const answer = await state.pc.createAnswer();
            await state.pc.setLocalDescription(answer);
            state.socket.emit("webrtc:answer", { call_id: data.call_id, answer: state.pc.localDescription });
        } catch (err) {
            showToast("WebRTC offer failed.", "error");
        }
    });
    state.socket.on("webrtc:answer", async (data) => {
        if (!state.pc || state.call?.call_id !== data.call_id) return;
        try {
            await state.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            await flushCandidates();
        } catch { }
    });
    state.socket.on("webrtc:ice", async (data) => {
        if (!state.call || state.call.call_id !== data.call_id || !data.candidate) return;
        try {
            const c = new RTCIceCandidate(data.candidate);
            if (state.pc && state.pc.remoteDescription) await state.pc.addIceCandidate(c);
            else state.pendingCandidates.push(c);
        } catch { }
    });
}

/* =========================================================
   LOAD CHATS
========================================================= */
async function loadChats() {
    try {
        const data = await api("/api/chats");
        state.chats = Array.isArray(data.chats) ? data.chats : [];
        renderChatList();
    } catch (err) {
        showToast(err.message, "error");
    }
}

/* =========================================================
   RENDER CHAT LIST
========================================================= */
function renderChatList() {
    const el = $("#chat-list");
    if (!state.chats.length) {
        el.innerHTML = `<div class="muted" style="padding:24px;text-align:center;line-height:1.6">No chats yet.<br>Search a username above.</div>`;
        return;
    }
    el.innerHTML = state.chats.map((chat) => {
        const active = state.activeChat?.conversation_id === chat.conversation_id;
        const last = chat.last_message;
        // preview: file or text
        let preview = "Start chatting";
        if (last) {
            if (last.is_deleted) preview = "🗑 Deleted message";
            else if (last.file_type === "image") preview = "📷 Photo";
            else if (last.file_type === "video") preview = "🎥 Video";
            else if (last.file_type === "file") preview = "📎 " + (last.file_name || "File");
            else preview = last.message;
        }
        return `
        <div class="chat-item ${active ? "active" : ""}" data-id="${chat.conversation_id}">
            <img class="avatar" src="${escapeHtml(avatarUrl(chat.user))}" alt="">
            <div class="chat-meta">
                <div class="chat-top">
                    <span class="chat-name">${escapeHtml(chat.user.display_name)}</span>
                    <span class="chat-time">${last ? formatTime(last.created_at) : ""}</span>
                </div>
                <div class="chat-preview">${escapeHtml(preview)}</div>
            </div>
            ${chat.unread_count ? `<span class="badge">${chat.unread_count > 99 ? "99+" : chat.unread_count}</span>` : ""}
        </div>`;
    }).join("");

    el.querySelectorAll(".chat-item").forEach((item) => {
        item.addEventListener("click", () => {
            const conv = state.chats.find((c) => c.conversation_id === Number(item.dataset.id));
            if (conv) openChat(conv);
        });
    });
}

/* =========================================================
   USER SEARCH
========================================================= */
$("#user-search").addEventListener("input", async (e) => {
    const q = e.target.value.trim();
    const box = $("#search-results");
    if (q.length < 2) { box.classList.add("hidden"); return; }
    try {
        const data = await api("/api/users/search?q=" + encodeURIComponent(q));
        if (!data.users?.length) {
            box.innerHTML = `<div class="result muted">No user found</div>`;
        } else {
            box.innerHTML = data.users.map((u) => `
            <div class="result" data-user-id="${u.id}">
                <img class="avatar" src="${escapeHtml(avatarUrl(u))}" alt="">
                <div>
                    <strong>${escapeHtml(u.display_name)}</strong>
                    <div class="muted">@${escapeHtml(u.username)}</div>
                </div>
            </div>`).join("");
            box.querySelectorAll(".result[data-user-id]").forEach((item) => {
                item.addEventListener("click", () => startChat(Number(item.dataset.userId)));
            });
        }
        box.classList.remove("hidden");
    } catch (err) {
        showToast(err.message, "error");
    }
});

/* =========================================================
   START CHAT
========================================================= */
async function startChat(userId) {
    try {
        const data = await api(`/api/chats/${userId}`, { method: "POST", body: "{}" });
        $("#user-search").value = "";
        $("#search-results").classList.add("hidden");
        let chat = state.chats.find((c) => c.conversation_id === data.conversation_id);
        if (!chat) {
            chat = { conversation_id: data.conversation_id, user: data.user, last_message: null, unread_count: 0 };
            state.chats.unshift(chat);
        } else {
            chat.user = data.user;
        }
        await openChat(chat);
        renderChatList();
    } catch (err) {
        showToast(err.message, "error");
    }
}

/* =========================================================
   OPEN CHAT
========================================================= */
async function openChat(chat) {
    state.activeChat = chat;
    state.replyTo = null;
    $("#reply-bar").classList.add("hidden");
    $("#empty-chat").classList.add("hidden");
    $("#active-chat").classList.remove("hidden");
    $("#app-view").classList.add("chat-open");
    renderChatHeader();
    $("#messages").innerHTML = "";
    try {
        const data = await api(`/api/chats/${chat.conversation_id}/messages?limit=100`);
        state.messages.set(chat.conversation_id, data.messages || []);
        renderMessages();
        markRead();
        loadPinnedBar(chat.conversation_id);
        await loadChats();
    } catch (err) {
        showToast(err.message, "error");
    }
}

/* =========================================================
   PINNED BAR
========================================================= */
async function loadPinnedBar(conversationId) {
    try {
        const data = await api(`/api/chats/${conversationId}/pinned`);
        const bar = $("#pinned-bar");
        if (data.messages && data.messages.length > 0) {
            const top = data.messages[0];
            $("#pinned-text").textContent = top.message || (top.file_type === "image" ? "📷 Photo" : "📎 File");
            bar.classList.remove("hidden");
        } else {
            bar.classList.add("hidden");
        }
    } catch { }
}

$("#pinned-close").addEventListener("click", () => {
    $("#pinned-bar").classList.add("hidden");
});

$("#pin-view-btn").addEventListener("click", async () => {
    if (!state.activeChat) return;
    try {
        const data = await api(`/api/chats/${state.activeChat.conversation_id}/pinned`);
        if (!data.messages?.length) { showToast("No pinned messages", "info"); return; }
        showToast(`📌 ${data.messages.length} pinned message(s)`, "info");
    } catch { }
});

/* =========================================================
   CHAT HEADER
========================================================= */
function renderChatHeader() {
    if (!state.activeChat) return;
    const user = state.activeChat.user;
    $("#chat-avatar").src = avatarUrl(user);
    $("#chat-name").textContent = user.display_name;
    const presence = $("#chat-presence");
    presence.textContent = lastSeenText(user);
    presence.classList.toggle("online", Boolean(user.online));
}

/* =========================================================
   RENDER MESSAGES
========================================================= */
function renderMessages() {
    if (!state.activeChat) return;
    const list = state.messages.get(state.activeChat.conversation_id) || [];
    const el = $("#messages");
    let html = "";
    let prevDate = "";

    for (const msg of list) {
        const date = formatDate(msg.created_at);
        if (date && date !== prevDate) {
            html += `<div class="date-separator">${escapeHtml(date)}</div>`;
            prevDate = date;
        }

        const mine = msg.sender_id === state.me.id;

        // Ticks
        let ticks = "";
        if (mine) {
            if (msg.read_at) ticks = `<span class="ticks read">✓✓</span>`;
            else if (msg.delivered_at) ticks = `<span class="ticks">✓✓</span>`;
            else ticks = `<span class="ticks">✓</span>`;
        }

        // Forward badge
        const fwdBadge = msg.forwarded_from
            ? `<div class="fwd-badge">↗ Forwarded from ${escapeHtml(msg.forwarded_from)}</div>`
            : "";

        // Reply preview
        let replyHtml = "";
        if (msg.reply_to) {
            const r = msg.reply_to;
            const previewText = r.file_type === "image" ? "📷 Photo" : escapeHtml(r.message?.slice(0, 80) || "");
            replyHtml = `
            <div class="reply-preview">
                <div class="reply-preview-line"></div>
                <div>
                    <div class="reply-preview-name">${escapeHtml(r.sender_name)}</div>
                    <div class="reply-preview-text">${previewText}</div>
                </div>
            </div>`;
        }

        // Message content
        let contentHtml = "";
        if (msg.is_deleted) {
            contentHtml = `<span class="deleted-msg">🗑 This message was deleted</span>`;
        } else if (msg.file_type === "image") {
            contentHtml = `<img class="msg-image" src="${escapeHtml(msg.file_url)}" alt="image" loading="lazy">`;
            if (msg.message) contentHtml += `<div>${escapeHtml(msg.message)}</div>`;
        } else if (msg.file_type === "video") {
            contentHtml = `<video class="msg-video" src="${escapeHtml(msg.file_url)}" controls></video>`;
        } else if (msg.file_type === "file") {
            contentHtml = `
            <a class="msg-file" href="${escapeHtml(msg.file_url)}" target="_blank" download>
                <span class="file-icon">📎</span>
                <span>${escapeHtml(msg.file_name || "Download file")}</span>
            </a>`;
        } else {
            contentHtml = escapeHtml(msg.message);
        }

        // Edited badge
        const editedBadge = msg.is_edited && !msg.is_deleted
            ? `<span class="edited-badge">edited</span>` : "";

        // Reactions
        let reactionsHtml = "";
        if (msg.reactions && Object.keys(msg.reactions).length) {
            reactionsHtml = `<div class="reactions-row">` +
                Object.entries(msg.reactions).map(([emoji, count]) =>
                    `<span class="reaction-bubble" data-emoji="${escapeHtml(emoji)}" data-msgid="${msg.id}">${escapeHtml(emoji)} ${count}</span>`
                ).join("") +
                `</div>`;
        }

        html += `
        <div class="message-row ${mine ? "mine" : ""} ${msg.is_deleted ? "deleted" : ""}"
             data-message-id="${msg.id}"
             data-sender="${msg.sender_id}"
             data-receiver="${msg.receiver_id}">
            <div class="bubble" data-message-id="${msg.id}">
                ${fwdBadge}
                ${replyHtml}
                ${contentHtml}
                ${reactionsHtml}
                <span class="msg-time">${formatTime(msg.created_at)} ${editedBadge} ${ticks}</span>
            </div>
        </div>`;
    }

    el.innerHTML = html;

    // Reaction bubble click
    el.querySelectorAll(".reaction-bubble").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            reactToMessage(Number(btn.dataset.msgid), btn.dataset.emoji);
        });
    });

    // Context menu (right-click or long-press)
    el.querySelectorAll(".bubble").forEach((bubble) => {
        bubble.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            showContextMenu(e, Number(bubble.dataset.messageId));
        });
        // Mobile long-press
        let pressTimer;
        bubble.addEventListener("touchstart", (e) => {
            pressTimer = setTimeout(() => {
                showContextMenu(e.touches[0], Number(bubble.dataset.messageId));
            }, 500);
        });
        bubble.addEventListener("touchend", () => clearTimeout(pressTimer));
    });

    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

/* =========================================================
   CONTEXT MENU
========================================================= */
function showContextMenu(e, messageId) {
    state.contextTarget = messageId;
    const menu = $("#context-menu");
    const msg = findMessage(messageId);
    const mine = msg?.sender_id === state.me.id;

    // Show/hide edit & delete only for own messages
    menu.querySelector("[data-action='edit']").style.display = mine && !msg?.is_deleted ? "block" : "none";
    menu.querySelector("[data-action='delete']").style.display = mine && !msg?.is_deleted ? "block" : "none";

    menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + "px";
    menu.style.top = Math.min(e.clientY, window.innerHeight - 220) + "px";
    menu.classList.remove("hidden");
}

document.addEventListener("click", (e) => {
    if (!$("#context-menu").contains(e.target)) {
        $("#context-menu").classList.add("hidden");
    }
    if (!$("#emoji-panel").contains(e.target) && e.target.id !== "emoji-btn") {
        $("#emoji-panel").classList.add("hidden");
    }
});

$("#context-menu").querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        const msgId = state.contextTarget;
        $("#context-menu").classList.add("hidden");
        if (!msgId) return;

        if (action === "reply") startReply(msgId);
        else if (action === "copy") copyMessage(msgId);
        else if (action === "edit") openEditModal(msgId);
        else if (action === "pin") pinMsg(msgId);
        else if (action === "forward") openForwardModal(msgId);
        else if (action === "delete") deleteMsg(msgId);
    });
});

/* =========================================================
   FIND MESSAGE HELPER
========================================================= */
function findMessage(msgId) {
    for (const list of state.messages.values()) {
        const m = list.find((x) => x.id === msgId);
        if (m) return m;
    }
    return null;
}

/* =========================================================
   REPLY
========================================================= */
function startReply(msgId) {
    const msg = findMessage(msgId);
    if (!msg) return;
    const sender = msg.sender_id === state.me.id ? "You" : state.activeChat?.user?.display_name || "User";
    state.replyTo = { id: msg.id, message: msg.message, sender_name: sender };
    $("#reply-bar-name").textContent = sender;
    $("#reply-bar-text").textContent = msg.file_type === "image" ? "📷 Photo" : (msg.message?.slice(0, 80) || "");
    $("#reply-bar").classList.remove("hidden");
    $("#message-input").focus();
}

$("#cancel-reply").addEventListener("click", () => {
    state.replyTo = null;
    $("#reply-bar").classList.add("hidden");
});

/* =========================================================
   COPY
========================================================= */
function copyMessage(msgId) {
    const msg = findMessage(msgId);
    if (!msg?.message) return;
    navigator.clipboard.writeText(msg.message).then(() => showToast("Copied!", "success")).catch(() => { });
}

/* =========================================================
   EDIT
========================================================= */
function openEditModal(msgId) {
    const msg = findMessage(msgId);
    if (!msg) return;
    state.editTarget = msgId;
    $("#edit-text").value = msg.message;
    $("#edit-modal").classList.remove("hidden");
}

$("#edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const newText = $("#edit-text").value.trim();
    if (!newText || !state.editTarget) return;
    try {
        await api(`/api/messages/${state.editTarget}`, {
            method: "PUT",
            body: JSON.stringify({ message: newText }),
        });
        $("#edit-modal").classList.add("hidden");
        state.editTarget = null;
        showToast("Message edited", "success");
    } catch (err) {
        showToast(err.message, "error");
    }
});

/* =========================================================
   PIN
========================================================= */
async function pinMsg(msgId) {
    try {
        const data = await api(`/api/messages/${msgId}/pin`, { method: "POST", body: "{}" });
        showToast(data.is_pinned ? "📌 Message pinned" : "Message unpinned", "success");
    } catch (err) {
        showToast(err.message, "error");
    }
}

/* =========================================================
   DELETE
========================================================= */
async function deleteMsg(msgId) {
    if (!confirm("Delete this message?")) return;
    try {
        await api(`/api/messages/${msgId}`, { method: "DELETE" });
    } catch (err) {
        showToast(err.message, "error");
    }
}

/* =========================================================
   FORWARD MODAL
========================================================= */
let forwardMsgId = null;

function openForwardModal(msgId) {
    forwardMsgId = msgId;
    const list = $("#forward-chat-list");
    list.innerHTML = state.chats.map((c) => `
    <div class="result" data-conv-id="${c.conversation_id}" data-user-id="${c.user.id}">
        <img class="avatar" src="${escapeHtml(avatarUrl(c.user))}" alt="">
        <div><strong>${escapeHtml(c.user.display_name)}</strong></div>
    </div>`).join("");

    list.querySelectorAll(".result").forEach((item) => {
        item.addEventListener("click", async () => {
            const receiverId = Number(item.dataset.userId);
            try {
                await api(`/api/messages/${forwardMsgId}/forward`, {
                    method: "POST",
                    body: JSON.stringify({ receiver_id: receiverId }),
                });
                showToast("Message forwarded", "success");
                $("#forward-modal").classList.add("hidden");
            } catch (err) {
                showToast(err.message, "error");
            }
        });
    });

    $("#forward-modal").classList.remove("hidden");
}

/* =========================================================
   EMOJI PANEL (for reactions)
========================================================= */
let emojiTargetMsgId = null;

$("#emoji-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    // If a message is context-targeted use that, otherwise show generic panel
    const panel = $("#emoji-panel");
    panel.style.bottom = "80px";
    panel.style.right = "60px";
    panel.classList.toggle("hidden");
});

$("#emoji-panel").querySelectorAll("span[data-emoji]").forEach((span) => {
    span.addEventListener("click", () => {
        if (state.contextTarget) {
            reactToMessage(state.contextTarget, span.dataset.emoji);
        } else if (emojiTargetMsgId) {
            reactToMessage(emojiTargetMsgId, span.dataset.emoji);
        } else {
            // Insert emoji into message input
            const input = $("#message-input");
            input.value += span.dataset.emoji;
            input.focus();
        }
        $("#emoji-panel").classList.add("hidden");
    });
});

async function reactToMessage(msgId, emoji) {
    try {
        await api(`/api/messages/${msgId}/react`, {
            method: "POST",
            body: JSON.stringify({ emoji }),
        });
    } catch (err) {
        showToast(err.message, "error");
    }
}

/* =========================================================
   FILE UPLOAD
========================================================= */
$("#file-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file || !state.activeChat || !state.socket?.connected) return;

    const formData = new FormData();
    formData.append("file", file);

    try {
        showToast("Uploading...", "info");
        const data = await api("/api/upload", { method: "POST", body: formData });

        state.socket.emit("chat:send", {
            receiver_id: state.activeChat.user.id,
            message: "",
            file_url: data.file_url,
            file_name: data.file_name,
            file_type: data.file_type,
            reply_to_id: state.replyTo?.id || null,
        });

        state.replyTo = null;
        $("#reply-bar").classList.add("hidden");
        showToast("File sent!", "success");
    } catch (err) {
        showToast(err.message, "error");
    }

    e.target.value = "";
});

/* =========================================================
   SEND MESSAGE
========================================================= */
$("#message-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#message-input").value.trim();
    if (!text || !state.activeChat) return;

    // Socket not connected — try to reconnect and show error
    if (!state.socket || !state.socket.connected) {
        showToast("Connection lost. Reconnecting...", "error");
        if (state.socket) state.socket.connect();
        return;
    }

    state.socket.emit("chat:send", {
        receiver_id: state.activeChat.user.id,
        message: text,
        reply_to_id: state.replyTo?.id || null,
    });

    $("#message-input").value = "";
    state.replyTo = null;
    $("#reply-bar").classList.add("hidden");
    stopTyping();
});

/* =========================================================
   TYPING
========================================================= */
$("#message-input").addEventListener("input", () => {
    if (!state.activeChat || !state.socket?.connected) return;
    if (!state.typingActive) {
        state.typingActive = true;
        state.socket.emit("typing:start", { receiver_id: state.activeChat.user.id });
    }
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(stopTyping, 1000);
});

function stopTyping() {
    if (state.activeChat && state.typingActive && state.socket?.connected) {
        state.socket.emit("typing:stop", { receiver_id: state.activeChat.user.id });
    }
    state.typingActive = false;
}

/* =========================================================
   SOCKET EVENT HANDLERS
========================================================= */
function handleNewMessage(msg) {
    let chat = state.chats.find((c) => c.conversation_id === msg.conversation_id);
    if (!chat) { loadChats(); return; }

    const list = state.messages.get(msg.conversation_id) || [];
    if (!list.some((m) => m.id === msg.id)) {
        list.push(msg);
        state.messages.set(msg.conversation_id, list);
    }

    chat.last_message = msg;
    if (msg.sender_id !== state.me.id && state.activeChat?.conversation_id !== msg.conversation_id) {
        chat.unread_count = (chat.unread_count || 0) + 1;
    }

    if (state.activeChat?.conversation_id === msg.conversation_id) {
        renderMessages();
        if (msg.receiver_id === state.me.id) markRead();
    }
    renderChatList();

    if (msg.sender_id !== state.me.id && state.activeChat?.conversation_id !== msg.conversation_id) {
        showToast("New message from " + (chat.user?.display_name || "someone"), "info");
    }
}

function handleMessageStatus(data) {
    const list = state.messages.get(data.conversation_id) || [];
    const msg = list.find((m) => m.id === data.message_id);
    if (!msg) return;
    if (data.status === "delivered") msg.delivered_at = data.delivered_at;
    if (data.status === "read") { msg.read_at = data.read_at; msg.delivered_at = msg.delivered_at || data.read_at; }
    if (state.activeChat?.conversation_id === data.conversation_id) renderMessages();
}

function handleMessageDeleted(data) {
    const list = state.messages.get(data.conversation_id) || [];
    const msg = list.find((m) => m.id === data.message_id);
    if (msg) { msg.is_deleted = true; msg.message = ""; }
    if (state.activeChat?.conversation_id === data.conversation_id) renderMessages();
}

function handleMessageEdited(data) {
    const list = state.messages.get(data.conversation_id) || [];
    const idx = list.findIndex((m) => m.id === data.id);
    if (idx !== -1) list[idx] = data;
    if (state.activeChat?.conversation_id === data.conversation_id) renderMessages();
}

function handleMessagePinned(data) {
    const list = state.messages.get(data.conversation_id) || [];
    const msg = list.find((m) => m.id === data.message_id);
    if (msg) msg.is_pinned = data.is_pinned;
    if (state.activeChat?.conversation_id === data.conversation_id) {
        loadPinnedBar(data.conversation_id);
        renderMessages();
    }
}

function handleMessageReaction(data) {
    const list = state.messages.get(data.conversation_id) || [];
    const msg = list.find((m) => m.id === data.message_id);
    if (msg) msg.reactions = data.reactions;
    if (state.activeChat?.conversation_id === data.conversation_id) renderMessages();
}

function handleTyping(data) {
    if (state.activeChat?.conversation_id === data.conversation_id) {
        $("#typing-bar").classList.toggle("hidden", !data.typing);
        if (data.typing) {
            clearTimeout(state.typingTimer);
            state.typingTimer = setTimeout(() => $("#typing-bar").classList.add("hidden"), 2500);
        }
    }
}

function handlePresence(data) {
    const chat = state.chats.find((c) => c.user.id === data.user_id);
    if (chat) chat.user = { ...chat.user, online: data.online, last_seen: data.last_seen };
    if (state.activeChat?.user.id === data.user_id) {
        state.activeChat.user = { ...state.activeChat.user, online: data.online, last_seen: data.last_seen };
        renderChatHeader();
    }
    renderChatList();
}

/* =========================================================
   MARK READ
========================================================= */
function markRead() {
    if (!state.activeChat || !state.socket?.connected) return;
    state.socket.emit("chat:read", { conversation_id: state.activeChat.conversation_id });
    const chat = state.chats.find((c) => c.conversation_id === state.activeChat.conversation_id);
    if (chat) chat.unread_count = 0;
    renderChatList();
}

/* =========================================================
   LOGOUT
========================================================= */
$("#logout-btn").addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST", body: "{}" }); } catch { }
    if (state.socket) state.socket.disconnect();
    location.reload();
});

/* =========================================================
   PROFILE
========================================================= */
$("#profile-btn").addEventListener("click", () => {
    if (!state.me) return;
    $("#profile-username").textContent = "@" + state.me.username;
    $("#profile-display-name").value = state.me.display_name;
    $("#profile-preview-img").src = avatarUrl(state.me);
    $("#profile-modal").classList.remove("hidden");
});

$("#profile-photo").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file || !file.type.startsWith("image/")) {
        showToast("Please select an image.", "error");
        e.target.value = "";
        return;
    }
    $("#profile-preview-img").src = URL.createObjectURL(file);
});

$("#profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const formData = new FormData();
    formData.append("display_name", $("#profile-display-name").value.trim());
    const file = $("#profile-photo").files[0];
    if (file) formData.append("profile_photo", file);
    try {
        const data = await api("/api/profile", { method: "POST", body: formData });
        state.me = data.user;
        $("#profile-modal").classList.add("hidden");
        showToast("Profile updated", "success");
        await loadChats();
        if (state.activeChat) renderChatHeader();
    } catch (err) {
        showToast(err.message, "error");
    }
});

/* =========================================================
   CLOSE MODALS
========================================================= */
document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.getElementById(btn.dataset.close)?.classList.add("hidden");
    });
});

/* =========================================================
   MOBILE BACK
========================================================= */
$("#back-chat-btn").addEventListener("click", () => {
    $("#app-view").classList.remove("chat-open");
    state.activeChat = null;
    $("#active-chat").classList.add("hidden");
    $("#empty-chat").classList.remove("hidden");
    renderChatList();
});

/* =========================================================
   CALLS
========================================================= */
$("#voice-call-btn").addEventListener("click", () => startCall("voice"));
$("#video-call-btn").addEventListener("click", () => startCall("video"));

async function startCall(type) {
    if (!state.activeChat || !state.socket?.connected) { showToast("Not connected.", "error"); return; }
    if (!navigator.mediaDevices?.getUserMedia) { showToast("Camera/mic not supported.", "error"); return; }
    try {
        state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: type === "video" });
        state.socket.emit("call:start", { receiver_id: state.activeChat.user.id, call_type: type });
    } catch { showToast("Camera/mic permission required.", "error"); }
}

function openCallModal(data, status) {
    const user = data.direction === "outgoing" ? state.activeChat?.user : data.caller;
    if (!user) return;
    $("#call-avatar").src = avatarUrl(user);
    $("#call-name").textContent = user.display_name;
    $("#call-status").textContent = status;
    $("#call-modal").classList.remove("hidden");
    $("#remote-video-wrap").classList.toggle("hidden", data.call_type !== "video");
    $("#accept-call").classList.add("hidden");
    $("#reject-call").classList.add("hidden");
    $("#end-call").classList.add("hidden");
}

function incomingCall(data) {
    if (state.call) { state.socket.emit("call:reject", { call_id: data.call_id }); return; }
    state.call = { ...data, direction: "incoming" };
    openCallModal(state.call, `Incoming ${data.call_type} call`);
    $("#accept-call").classList.remove("hidden");
    $("#reject-call").classList.remove("hidden");
}

$("#accept-call").addEventListener("click", async () => {
    if (!state.call) return;
    try {
        state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: state.call.call_type === "video" });
        await createPeerConnection();
        state.socket.emit("call:accept", { call_id: state.call.call_id });
        $("#accept-call").classList.add("hidden");
        $("#reject-call").classList.add("hidden");
        $("#end-call").classList.remove("hidden");
        $("#call-status").textContent = "Connecting…";
    } catch { showToast("Permission denied.", "error"); state.socket.emit("call:reject", { call_id: state.call.call_id }); endCallLocal(); }
});

$("#reject-call").addEventListener("click", () => {
    if (state.call) state.socket.emit("call:reject", { call_id: state.call.call_id });
    endCallLocal();
});

$("#end-call").addEventListener("click", () => {
    if (state.call) state.socket.emit("call:end", { call_id: state.call.call_id });
    endCallLocal();
});

async function createPeerConnection() {
    if (state.pc) return state.pc;
    state.pendingCandidates = [];
    state.pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    if (state.localStream) state.localStream.getTracks().forEach((t) => state.pc.addTrack(t, state.localStream));
    state.pc.onicecandidate = (e) => { if (e.candidate && state.call) state.socket.emit("webrtc:ice", { call_id: state.call.call_id, candidate: e.candidate }); };
    state.pc.ontrack = (e) => {
        if (e.streams?.[0]) $("#remote-video").srcObject = e.streams[0];
        $("#call-status").textContent = "Connected";
        if (state.call?.call_type === "video") { $("#local-video").srcObject = state.localStream; $("#remote-video-wrap").classList.remove("hidden"); }
    };
    state.pc.onconnectionstatechange = () => {
        if (!state.pc) return;
        if (state.pc.connectionState === "connected") $("#call-status").textContent = "Connected";
        if (["failed", "disconnected"].includes(state.pc.connectionState)) $("#call-status").textContent = "Connection ended";
    };
    return state.pc;
}

async function makeOffer() {
    if (!state.pc || !state.call) return;
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    state.socket.emit("webrtc:offer", { call_id: state.call.call_id, offer: state.pc.localDescription });
}

async function flushCandidates() {
    if (!state.pc?.remoteDescription) return;
    const cs = state.pendingCandidates.splice(0);
    for (const c of cs) { try { await state.pc.addIceCandidate(c); } catch { } }
}

function endCallLocal() {
    state.localStream?.getTracks().forEach((t) => t.stop());
    try { state.pc?.close(); } catch { }
    state.localStream = null;
    state.pc = null;
    state.pendingCandidates = [];
    if ($("#remote-video")) $("#remote-video").srcObject = null;
    if ($("#local-video")) $("#local-video").srcObject = null;
    $("#call-modal").classList.add("hidden");
    state.call = null;
}

/* =========================================================
   KEYBOARD / CLICK CLOSE
========================================================= */
document.addEventListener("click", (e) => {
    const search = $(".search-box");
    const results = $("#search-results");
    if (search && results && !search.contains(e.target) && !results.contains(e.target)) {
        results.classList.add("hidden");
    }
});

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        $("#search-results")?.classList.add("hidden");
        $("#profile-modal")?.classList.add("hidden");
        $("#edit-modal")?.classList.add("hidden");
        $("#forward-modal")?.classList.add("hidden");
        $("#context-menu")?.classList.add("hidden");
        $("#emoji-panel")?.classList.add("hidden");
        if (state.replyTo) { state.replyTo = null; $("#reply-bar").classList.add("hidden"); }
    }
});

window.addEventListener("beforeunload", () => { if (state.socket) state.socket.disconnect(); });
