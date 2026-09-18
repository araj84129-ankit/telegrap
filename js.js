"use strict";


/* =========================================================
   SHORT SELECTOR
========================================================= */

const $ = (selector) => {
    return document.querySelector(selector);
};


/* =========================================================
   APPLICATION STATE
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

    reconnecting: false

};


/* =========================================================
   DEFAULT AVATAR
========================================================= */

function defaultAvatar(name = "?") {

    return (
        "https://ui-avatars.com/api/" +
        "?name=" +
        encodeURIComponent(name) +
        "&background=e1e9f6" +
        "&color=345" +
        "&bold=true"
    );

}


function avatarUrl(user) {

    if (user && user.profile_photo) {

        return user.profile_photo;

    }

    return defaultAvatar(
        user?.display_name ||
        user?.username ||
        "?"
    );

}


/* =========================================================
   HTML ESCAPE
========================================================= */

function escapeHtml(value) {

    return String(value ?? "")
        .replace(/[&<>"']/g, (char) => {

            const map = {

                "&": "&amp;",

                "<": "&lt;",

                ">": "&gt;",

                '"': "&quot;",

                "'": "&#039;"

            };

            return map[char];

        });

}


/* =========================================================
   DATE HELPERS
========================================================= */

function parseDate(value) {

    if (!value) {
        return null;
    }

    const text = String(value);

    if (
        !text.endsWith("Z") &&
        !text.includes("+")
    ) {

        return new Date(text + "Z");

    }

    return new Date(text);

}


function formatTime(value) {

    const date = parseDate(value);

    if (!date || Number.isNaN(date.getTime())) {

        return "";

    }

    return date.toLocaleTimeString(
        [],
        {
            hour: "2-digit",
            minute: "2-digit"
        }
    );

}


function formatDate(value) {

    const date = parseDate(value);

    if (!date || Number.isNaN(date.getTime())) {

        return "";

    }

    const now = new Date();

    const today = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate()
    );

    const day = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate()
    );

    const diff = Math.round(
        (today - day) /
        86400000
    );


    if (diff === 0) {

        return "Today";

    }


    if (diff === 1) {

        return "Yesterday";

    }


    return date.toLocaleDateString(
        [],
        {
            day: "numeric",
            month: "short",
            year: "numeric"
        }
    );

}


/* =========================================================
   LAST SEEN
========================================================= */

function lastSeenText(user) {

    if (user?.online) {

        return "online";

    }


    if (!user?.last_seen) {

        return "offline";

    }


    return (
        "last seen " +
        formatDate(user.last_seen) +
        " " +
        formatTime(user.last_seen)
    );

}


/* =========================================================
   TOAST
========================================================= */

function showToast(
    message,
    type = "info"
) {

    const container =
        $("#toast-container");

    if (!container) {

        return;

    }


    const element =
        document.createElement("div");

    element.className =
        `toast ${type}`;

    element.textContent =
        message;


    container.appendChild(
        element
    );


    setTimeout(() => {

        element.remove();

    }, 3500);

}


/* =========================================================
   API HELPER
========================================================= */

async function api(
    url,
    options = {}
) {

    const config = {

        credentials: "same-origin",

        ...options

    };


    const headers = {

        ...(config.body instanceof FormData
            ? {}
            : {
                "Content-Type":
                    "application/json"
            }),

        ...(config.headers || {})

    };


    const response =
        await fetch(
            url,
            {
                ...config,
                headers
            }
        );


    const data =
        await response
            .json()
            .catch(() => ({}));


    if (!response.ok) {

        throw new Error(
            data.error ||
            `Request failed (${response.status})`
        );

    }


    return data;

}


/* =========================================================
   AUTH TAB
========================================================= */

function showAuth(tab) {

    $("#login-form")
        .classList
        .toggle(
            "hidden",
            tab !== "login"
        );


    $("#register-form")
        .classList
        .toggle(
            "hidden",
            tab !== "register"
        );


    document
        .querySelectorAll(".tab")
        .forEach((button) => {

            button.classList.toggle(
                "active",
                button.dataset.authTab === tab
            );

        });

}


document
    .querySelectorAll(".tab")
    .forEach((button) => {

        button.addEventListener(
            "click",
            () => {

                showAuth(
                    button.dataset.authTab
                );

            }
        );

    });


/* =========================================================
   LOGIN
========================================================= */

$("#login-form")
    .addEventListener(
        "submit",
        async (event) => {

            event.preventDefault();


            const identifier =
                $("#login-identifier")
                    .value
                    .trim();


            const password =
                $("#login-password")
                    .value;


            try {

                const data =
                    await api(
                        "/api/login",
                        {
                            method: "POST",

                            body:
                                JSON.stringify({
                                    identifier,
                                    password
                                })
                        }
                    );


                await enterApp(
                    data.user
                );


            } catch (error) {

                showToast(
                    error.message,
                    "error"
                );

            }

        }
    );


/* =========================================================
   REGISTER
========================================================= */

$("#register-form")
    .addEventListener(
        "submit",
        async (event) => {

            event.preventDefault();


            const payload = {

                username:
                    $("#reg-username")
                        .value
                        .trim(),

                display_name:
                    $("#reg-display-name")
                        .value
                        .trim(),

                email:
                    $("#reg-email")
                        .value
                        .trim(),

                phone:
                    $("#reg-phone")
                        .value
                        .trim(),

                password:
                    $("#reg-password")
                        .value

            };


            try {

                const data =
                    await api(
                        "/api/register",
                        {
                            method: "POST",

                            body:
                                JSON.stringify(
                                    payload
                                )
                        }
                    );


                await enterApp(
                    data.user
                );


            } catch (error) {

                showToast(
                    error.message,
                    "error"
                );

            }

        }
    );


/* =========================================================
   ENTER APPLICATION
========================================================= */

async function enterApp(user) {

    state.me = user;


    $("#auth-view")
        .classList
        .add("hidden");


    $("#app-view")
        .classList
        .remove("hidden");


    connectSocket();


    await loadChats();

}


/* =========================================================
   SESSION CHECK
========================================================= */

async function checkSession() {

    try {

        const data =
            await api(
                "/api/me"
            );


        await enterApp(
            data.user
        );


    } catch {

        showAuth("login");

    }

}


checkSession();


/* =========================================================
   SOCKET CONNECTION
========================================================= */

function connectSocket() {

    if (state.socket) {

        state.socket.disconnect();

    }


    state.socket =
        io(
            {
                transports: [
                    "websocket",
                    "polling"
                ],

                reconnection: true,

                reconnectionAttempts: Infinity,

                reconnectionDelay: 1000,

                timeout: 10000
            }
        );


    /* CONNECT */

    state.socket.on(
        "connect",
        () => {

            state.reconnecting = false;

            showToast(
                "Connected",
                "success"
            );


            if (state.activeChat) {

                markRead();

            }

        }
    );


    /* DISCONNECT */

    state.socket.on(
        "disconnect",
        () => {

            state.reconnecting = true;

            showToast(
                "Connection lost. Reconnecting...",
                "error"
            );

        }
    );


    /* CONNECTION ERROR */

    state.socket.on(
        "connect_error",
        () => {

            state.reconnecting = true;

        }
    );


    /* MESSAGE */

    state.socket.on(
        "message:new",
        handleNewMessage
    );


    /* MESSAGE STATUS */

    state.socket.on(
        "message:status",
        handleMessageStatus
    );


    /* TYPING */

    state.socket.on(
        "typing:update",
        handleTyping
    );


    /* PRESENCE */

    state.socket.on(
        "presence:update",
        handlePresence
    );


    /* SERVER ERROR */

    state.socket.on(
        "server:error",
        (data) => {

            showToast(
                data?.error ||
                "Server error",
                "error"
            );

        }
    );


    /* =====================================================
       CALL EVENTS
    ====================================================== */

    state.socket.on(
        "call:incoming",
        incomingCall
    );


    state.socket.on(
        "call:started",
        (data) => {

            state.call = {

                ...data,

                direction: "outgoing"

            };


            openCallModal(
                data,
                "Calling…"
            );


            $("#end-call")
                .classList
                .remove("hidden");

        }
    );


    state.socket.on(
        "call:accepted",
        async (data) => {

            if (
                !state.call ||
                state.call.call_id !==
                    data.call_id
            ) {

                return;

            }


            $("#call-status")
                .textContent =
                "Connecting…";


            try {

                await createPeerConnection();

                await makeOffer();

            } catch (error) {

                showToast(
                    error.message ||
                    "Could not start call.",
                    "error"
                );


                endCallLocal();

            }

        }
    );


    state.socket.on(
        "call:rejected",
        (data) => {

            if (
                state.call?.call_id ===
                data.call_id
            ) {

                $("#call-status")
                    .textContent =
                    "Call rejected";


                setTimeout(
                    endCallLocal,
                    1000
                );

            }

        }
    );


    state.socket.on(
        "call:ended",
        (data) => {

            if (
                state.call?.call_id ===
                data.call_id
            ) {

                $("#call-status")
                    .textContent =
                    "Call ended";


                setTimeout(
                    endCallLocal,
                    500
                );

            }

        }
    );


    /* =====================================================
       WEBRTC OFFER
    ====================================================== */

    state.socket.on(
        "webrtc:offer",
        async (data) => {

            if (
                !state.call ||
                state.call.call_id !==
                    data.call_id
            ) {

                return;

            }


            try {

                await createPeerConnection();


                await state.pc
                    .setRemoteDescription(
                        new RTCSessionDescription(
                            data.offer
                        )
                    );


                await flushCandidates();


                const answer =
                    await state.pc
                        .createAnswer();


                await state.pc
                    .setLocalDescription(
                        answer
                    );


                state.socket.emit(
                    "webrtc:answer",
                    {
                        call_id:
                            data.call_id,

                        answer:
                            state.pc.localDescription
                    }
                );


            } catch (error) {

                console.error(
                    "WebRTC offer error:",
                    error
                );


                showToast(
                    "WebRTC offer failed.",
                    "error"
                );

            }

        }
    );


    /* =====================================================
       WEBRTC ANSWER
    ====================================================== */

    state.socket.on(
        "webrtc:answer",
        async (data) => {

            if (
                !state.pc ||
                state.call?.call_id !==
                    data.call_id
            ) {

                return;

            }


            try {

                await state.pc
                    .setRemoteDescription(
                        new RTCSessionDescription(
                            data.answer
                        )
                    );


                await flushCandidates();


            } catch (error) {

                console.error(
                    "WebRTC answer error:",
                    error
                );


                showToast(
                    "WebRTC answer failed.",
                    "error"
                );

            }

        }
    );


    /* =====================================================
       WEBRTC ICE
    ====================================================== */

    state.socket.on(
        "webrtc:ice",
        async (data) => {

            if (
                !state.call ||
                state.call.call_id !==
                    data.call_id ||
                !data.candidate
            ) {

                return;

            }


            try {

                const candidate =
                    new RTCIceCandidate(
                        data.candidate
                    );


                if (
                    state.pc &&
                    state.pc.remoteDescription
                ) {

                    await state.pc
                        .addIceCandidate(
                            candidate
                        );

                } else {

                    state.pendingCandidates
                        .push(candidate);

                }

            } catch (error) {

                console.warn(
                    "ICE candidate error:",
                    error
                );

            }

        }
    );

}


/* =========================================================
   LOAD CHATS
========================================================= */

async function loadChats() {

    try {

        const data =
            await api(
                "/api/chats"
            );


        state.chats =
            Array.isArray(data.chats)
                ? data.chats
                : [];


        renderChatList();


    } catch (error) {

        showToast(
            error.message,
            "error"
        );

    }

}


/* =========================================================
   RENDER CHAT LIST
========================================================= */

function renderChatList() {

    const element =
        $("#chat-list");


    if (!state.chats.length) {

        element.innerHTML = `
            <div
                class="muted"
                style="
                    padding:24px;
                    text-align:center;
                    line-height:1.6;
                ">
                No chats yet.<br>
                Search a username above.
            </div>
        `;

        return;

    }


    element.innerHTML =
        state.chats
            .map((chat) => {

                const active =
                    state.activeChat &&
                    state.activeChat.conversation_id ===
                        chat.conversation_id;


                const last =
                    chat.last_message;


                return `

                    <div
                        class="chat-item
                        ${active ? "active" : ""}"
                        data-id="${chat.conversation_id}">

                        <img
                            class="avatar"
                            src="${escapeHtml(
                                avatarUrl(chat.user)
                            )}"
                            alt="">

                        <div class="chat-meta">

                            <div class="chat-top">

                                <span class="chat-name">
                                    ${escapeHtml(
                                        chat.user.display_name
                                    )}
                                </span>

                                <span class="chat-time">
                                    ${
                                        last
                                            ? formatTime(
                                                last.created_at
                                            )
                                            : ""
                                    }
                                </span>

                            </div>


                            <div class="chat-preview">

                                ${
                                    last
                                        ? escapeHtml(
                                            last.message
                                        )
                                        : "Start chatting"
                                }

                            </div>

                        </div>


                        ${
                            chat.unread_count
                                ? `
                                    <span class="badge">
                                        ${
                                            chat.unread_count > 99
                                                ? "99+"
                                                : chat.unread_count
                                        }
                                    </span>
                                `
                                : ""
                        }

                    </div>

                `;

            })
            .join("");


    element
        .querySelectorAll(".chat-item")
        .forEach((item) => {

            item.addEventListener(
                "click",
                () => {

                    const conversation =
                        state.chats.find(
                            (chat) =>
                                chat.conversation_id ===
                                Number(
                                    item.dataset.id
                                )
                        );


                    if (conversation) {

                        openChat(
                            conversation
                        );

                    }

                }
            );

        });

}


/* =========================================================
   USER SEARCH
========================================================= */

$("#user-search")
    .addEventListener(
        "input",
        async (event) => {

            const query =
                event.target.value
                    .trim();


            const box =
                $("#search-results");


            if (query.length < 2) {

                box.classList.add(
                    "hidden"
                );

                return;

            }


            try {

                const data =
                    await api(
                        "/api/users/search?q=" +
                        encodeURIComponent(query)
                    );


                if (
                    !data.users ||
                    !data.users.length
                ) {

                    box.innerHTML = `
                        <div class="result muted">
                            No user found
                        </div>
                    `;

                } else {

                    box.innerHTML =
                        data.users
                            .map((user) => {

                                return `

                                    <div
                                        class="result"
                                        data-user-id="${user.id}">

                                        <img
                                            class="avatar"
                                            src="${escapeHtml(
                                                avatarUrl(user)
                                            )}"
                                            alt="">

                                        <div>

                                            <strong>
                                                ${escapeHtml(
                                                    user.display_name
                                                )}
                                            </strong>

                                            <div class="muted">
                                                @${escapeHtml(
                                                    user.username
                                                )}
                                            </div>

                                        </div>

                                    </div>

                                `;

                            })
                            .join("");


                    box
                        .querySelectorAll(
                            ".result[data-user-id]"
                        )
                        .forEach((item) => {

                            item.addEventListener(
                                "click",
                                () => {

                                    startChat(
                                        Number(
                                            item.dataset.userId
                                        )
                                    );

                                }
                            );

                        });

                }


                box.classList.remove(
                    "hidden"
                );


            } catch (error) {

                showToast(
                    error.message,
                    "error"
                );

            }

        }
    );


/* =========================================================
   START CHAT
========================================================= */

async function startChat(userId) {

    try {

        const data =
            await api(
                `/api/chats/${userId}`,
                {
                    method: "POST",

                    body: "{}"
                }
            );


        $("#user-search")
            .value = "";


        $("#search-results")
            .classList
            .add("hidden");


        let chat =
            state.chats.find(
                (item) =>
                    item.conversation_id ===
                    data.conversation_id
            );


        if (!chat) {

            chat = {

                conversation_id:
                    data.conversation_id,

                user:
                    data.user,

                last_message:
                    null,

                unread_count:
                    0

            };


            state.chats.unshift(
                chat
            );

        } else {

            chat.user =
                data.user;

        }


        await openChat(chat);


        renderChatList();


    } catch (error) {

        showToast(
            error.message,
            "error"
        );

    }

}


/* =========================================================
   OPEN CHAT
========================================================= */

async function openChat(chat) {

    state.activeChat =
        chat;


    $("#empty-chat")
        .classList
        .add("hidden");


    $("#active-chat")
        .classList
        .remove("hidden");


    $("#app-view")
        .classList
        .add("chat-open");


    renderChatHeader();


    $("#messages")
        .innerHTML = "";


    try {

        const data =
            await api(
                `/api/chats/${chat.conversation_id}/messages?limit=100`
            );


        state.messages.set(
            chat.conversation_id,
            data.messages || []
        );


        renderMessages();


        markRead();


        await loadChats();


    } catch (error) {

        showToast(
            error.message,
            "error"
        );

    }

}


/* =========================================================
   CHAT HEADER
========================================================= */

function renderChatHeader() {

    if (!state.activeChat) {

        return;

    }


    const user =
        state.activeChat.user;


    $("#chat-avatar")
        .src =
        avatarUrl(user);


    $("#chat-name")
        .textContent =
        user.display_name;


    $("#chat-presence")
        .textContent =
        user.online
            ? "online"
            : lastSeenText(user);


    $("#chat-presence")
        .classList
        .toggle(
            "online",
            Boolean(user.online)
        );

}


/* =========================================================
   RENDER MESSAGES
========================================================= */

function renderMessages() {

    if (!state.activeChat) {

        return;

    }


    const list =
        state.messages.get(
            state.activeChat.conversation_id
        ) || [];


    const element =
        $("#messages");


    let html = "";

    let previousDate = "";


    for (const message of list) {

        const date =
            formatDate(
                message.created_at
            );


        if (
            date &&
            date !== previousDate
        ) {

            html += `
                <div class="date-separator">
                    ${escapeHtml(date)}
                </div>
            `;


            previousDate =
                date;

        }


        const mine =
            message.sender_id ===
            state.me.id;


        let ticks = "";


        if (mine) {

            const read =
                Boolean(
                    message.read_at
                );


            const delivered =
                Boolean(
                    message.delivered_at
                );


            if (read) {

                ticks = `
                    <span class="ticks read">
                        ✓✓
                    </span>
                `;

            } else if (delivered) {

                ticks = `
                    <span class="ticks">
                        ✓✓
                    </span>
                `;

            } else {

                ticks = `
                    <span class="ticks">
                        ✓
                    </span>
                `;

            }

        }


        html += `

            <div
                class="message-row
                ${mine ? "mine" : ""}"
                data-message-id="${message.id}">

                <div class="bubble">

                    ${escapeHtml(
                        message.message
                    )}

                    <span class="msg-time">

                        ${formatTime(
                            message.created_at
                        )}

                        ${ticks}

                    </span>

                </div>

            </div>

        `;

    }


    element.innerHTML =
        html;


    requestAnimationFrame(
        () => {

            element.scrollTop =
                element.scrollHeight;

        }
    );

}


/* =========================================================
   NEW MESSAGE
========================================================= */

function handleNewMessage(message) {

    let chat =
        state.chats.find(
            (item) =>
                item.conversation_id ===
                message.conversation_id
        );


    if (!chat) {

        loadChats();

        return;

    }


    const list =
        state.messages.get(
            message.conversation_id
        ) || [];


    if (
        !list.some(
            (item) =>
                item.id === message.id
        )
    ) {

        list.push(
            message
        );

        state.messages.set(
            message.conversation_id,
            list
        );

    }


    chat.last_message =
        message;


    if (
        message.sender_id !==
            state.me.id &&
        (
            !state.activeChat ||
            state.activeChat.conversation_id !==
                message.conversation_id
        )
    ) {

        chat.unread_count =
            (chat.unread_count || 0) + 1;

    }


    if (
        state.activeChat &&
        state.activeChat.conversation_id ===
            message.conversation_id
    ) {

        renderMessages();


        if (
            message.receiver_id ===
            state.me.id
        ) {

            markRead();

        }

    }


    renderChatList();


    if (
        message.sender_id !==
            state.me.id &&
        (
            !state.activeChat ||
            state.activeChat.conversation_id !==
                message.conversation_id
        )
    ) {

        showToast(
            "New message",
            "info"
        );

    }

}


/* =========================================================
   MESSAGE STATUS
========================================================= */

function handleMessageStatus(data) {

    const list =
        state.messages.get(
            data.conversation_id
        ) || [];


    const message =
        list.find(
            (item) =>
                item.id ===
                data.message_id
        );


    if (!message) {

        return;

    }


    if (
        data.status ===
        "delivered"
    ) {

        message.delivered_at =
            data.delivered_at;

    }


    if (
        data.status ===
        "read"
    ) {

        message.read_at =
            data.read_at;


        message.delivered_at =
            message.delivered_at ||
            data.read_at;

    }


    if (
        state.activeChat &&
        state.activeChat.conversation_id ===
            data.conversation_id
    ) {

        renderMessages();

    }

}


/* =========================================================
   MARK READ
========================================================= */

function markRead() {

    if (
        !state.activeChat ||
        !state.socket ||
        !state.socket.connected
    ) {

        return;

    }


    state.socket.emit(
        "chat:read",
        {
            conversation_id:
                state.activeChat.conversation_id
        }
    );


    const chat =
        state.chats.find(
            (item) =>
                item.conversation_id ===
                state.activeChat.conversation_id
        );


    if (chat) {

        chat.unread_count =
            0;

    }


    renderChatList();

}


/* =========================================================
   SEND MESSAGE
========================================================= */

$("#message-form")
    .addEventListener(
        "submit",
        (event) => {

            event.preventDefault();


            const text =
                $("#message-input")
                    .value
                    .trim();


            if (
                !text ||
                !state.activeChat ||
                !state.socket ||
                !state.socket.connected
            ) {

                return;

            }


            state.socket.emit(
                "chat:send",
                {
                    receiver_id:
                        state.activeChat.user.id,

                    message:
                        text
                }
            );


            $("#message-input")
                .value = "";


            stopTyping();

        }
    );


/* =========================================================
   TYPING
========================================================= */

$("#message-input")
    .addEventListener(
        "input",
        () => {

            if (
                !state.activeChat ||
                !state.socket ||
                !state.socket.connected
            ) {

                return;

            }


            if (!state.typingActive) {

                state.typingActive =
                    true;


                state.socket.emit(
                    "typing:start",
                    {
                        receiver_id:
                            state.activeChat.user.id
                    }
                );

            }


            clearTimeout(
                state.typingTimer
            );


            state.typingTimer =
                setTimeout(
                    stopTyping,
                    1000
                );

        }
    );


function stopTyping() {

    if (
        state.activeChat &&
        state.typingActive &&
        state.socket &&
        state.socket.connected
    ) {

        state.socket.emit(
            "typing:stop",
            {
                receiver_id:
                    state.activeChat.user.id
            }
        );

    }


    state.typingActive =
        false;

}


/* =========================================================
   HANDLE TYPING
========================================================= */

function handleTyping(data) {

    if (
        state.activeChat &&
        data.conversation_id ===
            state.activeChat.conversation_id
    ) {

        $("#typing-bar")
            .classList
            .toggle(
                "hidden",
                !data.typing
            );


        if (data.typing) {

            clearTimeout(
                state.typingTimer
            );


            state.typingTimer =
                setTimeout(
                    () => {

                        $("#typing-bar")
                            .classList
                            .add("hidden");

                    },
                    2500
                );

        }

    }

}


/* =========================================================
   PRESENCE
========================================================= */

function handlePresence(data) {

    const chat =
        state.chats.find(
            (item) =>
                item.user.id ===
                data.user_id
        );


    if (chat) {

        chat.user = {

            ...chat.user,

            online:
                data.online,

            last_seen:
                data.last_seen

        };

    }


    if (
        state.activeChat &&
        state.activeChat.user.id ===
            data.user_id
    ) {

        state.activeChat.user = {

            ...state.activeChat.user,

            online:
                data.online,

            last_seen:
                data.last_seen

        };


        renderChatHeader();

    }


    renderChatList();

}


/* =========================================================
   LOGOUT
========================================================= */

$("#logout-btn")
    .addEventListener(
        "click",
        async () => {

            try {

                await api(
                    "/api/logout",
                    {
                        method: "POST",

                        body: "{}"
                    }
                );

            } catch {

                // Ignore logout API errors.

            }


            if (state.socket) {

                state.socket.disconnect();

            }


            location.reload();

        }
    );


/* =========================================================
   PROFILE OPEN
========================================================= */

$("#profile-btn")
    .addEventListener(
        "click",
        () => {

            if (!state.me) {

                return;

            }


            $("#profile-username")
                .textContent =
                "@" +
                state.me.username;


            $("#profile-display-name")
                .value =
                state.me.display_name;


            $("#profile-preview-img")
                .src =
                avatarUrl(state.me);


            $("#profile-modal")
                .classList
                .remove("hidden");

        }
    );


/* =========================================================
   CLOSE MODALS
========================================================= */

document
    .querySelectorAll("[data-close]")
    .forEach((button) => {

        button.addEventListener(
            "click",
            () => {

                const id =
                    button.dataset.close;


                const modal =
                    document.getElementById(
                        id
                    );


                if (modal) {

                    modal.classList.add(
                        "hidden"
                    );

                }

            }
        );

    });


/* =========================================================
   PROFILE PHOTO PREVIEW
========================================================= */

$("#profile-photo")
    .addEventListener(
        "change",
        (event) => {

            const file =
                event.target.files[0];


            if (!file) {

                return;

            }


            if (
                !file.type.startsWith(
                    "image/"
                )
            ) {

                showToast(
                    "Please select an image.",
                    "error"
                );

                event.target.value = "";

                return;

            }


            $("#profile-preview-img")
                .src =
                URL.createObjectURL(
                    file
                );

        }
    );


/* =========================================================
   PROFILE SAVE
========================================================= */

$("#profile-form")
    .addEventListener(
        "submit",
        async (event) => {

            event.preventDefault();


            const formData =
                new FormData();


            formData.append(
                "display_name",
                $("#profile-display-name")
                    .value
                    .trim()
            );


            const file =
                $("#profile-photo")
                    .files[0];


            if (file) {

                formData.append(
                    "profile_photo",
                    file
                );

            }


            try {

                const data =
                    await api(
                        "/api/profile",
                        {
                            method: "POST",

                            body:
                                formData
                        }
                    );


                state.me =
                    data.user;


                $("#profile-modal")
                    .classList
                    .add("hidden");


                showToast(
                    "Profile updated",
                    "success"
                );


                await loadChats();


                if (state.activeChat) {

                    renderChatHeader();

                }


            } catch (error) {

                showToast(
                    error.message,
                    "error"
                );

            }

        }
    );


/* =========================================================
   MOBILE BACK
========================================================= */

$("#back-chat-btn")
    .addEventListener(
        "click",
        () => {

            $("#app-view")
                .classList
                .remove("chat-open");


            state.activeChat =
                null;


            $("#active-chat")
                .classList
                .add("hidden");


            $("#empty-chat")
                .classList
                .remove("hidden");


            renderChatList();

        }
    );


/* =========================================================
   START CALL
========================================================= */

$("#voice-call-btn")
    .addEventListener(
        "click",
        () => {

            startCall(
                "voice"
            );

        }
    );


$("#video-call-btn")
    .addEventListener(
        "click",
        () => {

            startCall(
                "video"
            );

        }
    );


async function startCall(type) {

    if (
        !state.activeChat ||
        !state.socket ||
        !state.socket.connected
    ) {

        showToast(
            "Chat connection is not ready.",
            "error"
        );

        return;

    }


    if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
    ) {

        showToast(
            "Camera/microphone is not supported by this browser.",
            "error"
        );

        return;

    }


    try {

        state.localStream =
            await navigator.mediaDevices
                .getUserMedia(
                    {
                        audio: true,

                        video:
                            type === "video"
                    }
                );


        state.socket.emit(
            "call:start",
            {
                receiver_id:
                    state.activeChat.user.id,

                call_type:
                    type
            }
        );


    } catch (error) {

        console.error(
            "Media error:",
            error
        );


        showToast(
            "Camera/microphone permission is required.",
            "error"
        );

    }

}


/* =========================================================
   OPEN CALL MODAL
========================================================= */

function openCallModal(
    data,
    status
) {

    let user;


    if (
        data.direction ===
        "outgoing"
    ) {

        user =
            state.activeChat?.user;

    } else {

        user =
            data.caller;

    }


    if (!user) {

        return;

    }


    $("#call-avatar")
        .src =
        avatarUrl(user);


    $("#call-name")
        .textContent =
        user.display_name;


    $("#call-status")
        .textContent =
        status;


    $("#call-modal")
        .classList
        .remove("hidden");


    $("#remote-video-wrap")
        .classList
        .toggle(
            "hidden",
            data.call_type !== "video"
        );


    $("#accept-call")
        .classList
        .add("hidden");


    $("#reject-call")
        .classList
        .add("hidden");


    $("#end-call")
        .classList
        .add("hidden");

}


/* =========================================================
   INCOMING CALL
========================================================= */

function incomingCall(data) {

    if (state.call) {

        state.socket.emit(
            "call:reject",
            {
                call_id:
                    data.call_id
            }
        );

        return;

    }


    state.call = {

        ...data,

        direction:
            "incoming"

    };


    openCallModal(
        state.call,
        `Incoming ${data.call_type} call`
    );


    $("#accept-call")
        .classList
        .remove("hidden");


    $("#reject-call")
        .classList
        .remove("hidden");

}


/* =========================================================
   ACCEPT CALL
========================================================= */

$("#accept-call")
    .addEventListener(
        "click",
        async () => {

            if (!state.call) {

                return;

            }


            try {

                state.localStream =
                    await navigator.mediaDevices
                        .getUserMedia(
                            {
                                audio: true,

                                video:
                                    state.call.call_type ===
                                    "video"
                            }
                        );


                await createPeerConnection();


                state.socket.emit(
                    "call:accept",
                    {
                        call_id:
                            state.call.call_id
                    }
                );


                $("#accept-call")
                    .classList
                    .add("hidden");


                $("#reject-call")
                    .classList
                    .add("hidden");


                $("#end-call")
                    .classList
                    .remove("hidden");


                $("#call-status")
                    .textContent =
                    "Connecting…";


            } catch (error) {

                console.error(
                    "Accept call error:",
                    error
                );


                showToast(
                    "Camera/microphone permission was denied.",
                    "error"
                );


                state.socket.emit(
                    "call:reject",
                    {
                        call_id:
                            state.call.call_id
                    }
                );


                endCallLocal();

            }

        }
    );


/* =========================================================
   REJECT CALL
========================================================= */

$("#reject-call")
    .addEventListener(
        "click",
        () => {

            if (state.call) {

                state.socket.emit(
                    "call:reject",
                    {
                        call_id:
                            state.call.call_id
                    }
                );

            }


            endCallLocal();

        }
    );


/* =========================================================
   END CALL
========================================================= */

$("#end-call")
    .addEventListener(
        "click",
        () => {

            if (state.call) {

                state.socket.emit(
                    "call:end",
                    {
                        call_id:
                            state.call.call_id
                    }
                );

            }


            endCallLocal();

        }
    );


/* =========================================================
   CREATE WEBRTC CONNECTION
========================================================= */

async function createPeerConnection() {

    if (state.pc) {

        return state.pc;

    }


    state.pendingCandidates =
        [];


    state.pc =
        new RTCPeerConnection(
            {
                iceServers: [
                    {
                        urls:
                            "stun:stun.l.google.com:19302"
                    }
                ]
            }
        );


    if (state.localStream) {

        state.localStream
            .getTracks()
            .forEach((track) => {

                state.pc.addTrack(
                    track,
                    state.localStream
                );

            });

    }


    /* ICE */

    state.pc.onicecandidate =
        (event) => {

            if (
                event.candidate &&
                state.call &&
                state.socket?.connected
            ) {

                state.socket.emit(
                    "webrtc:ice",
                    {
                        call_id:
                            state.call.call_id,

                        candidate:
                            event.candidate
                    }
                );

            }

        };


    /* REMOTE TRACK */

    state.pc.ontrack =
        (event) => {

            const video =
                $("#remote-video");


            if (
                event.streams &&
                event.streams[0]
            ) {

                video.srcObject =
                    event.streams[0];

            }


            $("#call-status")
                .textContent =
                "Connected";


            if (
                state.call &&
                state.call.call_type ===
                    "video"
            ) {

                $("#local-video")
                    .srcObject =
                    state.localStream;


                $("#remote-video-wrap")
                    .classList
                    .remove("hidden");

            }

        };


    /* CONNECTION STATE */

    state.pc.onconnectionstatechange =
        () => {

            if (!state.pc) {

                return;

            }


            const connectionState =
                state.pc
                    .connectionState;


            if (
                connectionState ===
                "connected"
            ) {

                $("#call-status")
                    .textContent =
                    "Connected";

            }


            if (
                connectionState ===
                    "failed" ||
                connectionState ===
                    "disconnected"
            ) {

                $("#call-status")
                    .textContent =
                    "Connection ended";

            }

        };


    return state.pc;

}


/* =========================================================
   MAKE OFFER
========================================================= */

async function makeOffer() {

    if (!state.pc || !state.call) {

        return;

    }


    const offer =
        await state.pc
            .createOffer();


    await state.pc
        .setLocalDescription(
            offer
        );


    state.socket.emit(
        "webrtc:offer",
        {
            call_id:
                state.call.call_id,

            offer:
                state.pc.localDescription
        }
    );

}


/* =========================================================
   FLUSH ICE CANDIDATES
========================================================= */

async function flushCandidates() {

    if (
        !state.pc ||
        !state.pc.remoteDescription
    ) {

        return;

    }


    const candidates =
        state.pendingCandidates
            .splice(0);


    for (
        const candidate
        of candidates
    ) {

        try {

            await state.pc
                .addIceCandidate(
                    candidate
                );

        } catch (error) {

            console.warn(
                "Could not add ICE candidate:",
                error
            );

        }

    }

}


/* =========================================================
   END CALL LOCALLY
========================================================= */

function endCallLocal() {

    if (state.localStream) {

        state.localStream
            .getTracks()
            .forEach((track) => {

                track.stop();

            });

    }


    if (state.pc) {

        try {

            state.pc.close();

        } catch {

            // Ignore close errors.

        }

    }


    state.localStream =
        null;


    state.pc =
        null;


    state.pendingCandidates =
        [];


    if ($("#remote-video")) {

        $("#remote-video")
            .srcObject =
            null;

    }


    if ($("#local-video")) {

        $("#local-video")
            .srcObject =
            null;

    }


    $("#call-modal")
        .classList
        .add("hidden");


    state.call =
        null;

}


/* =========================================================
   CLOSE SEARCH WHEN CLICKING OUTSIDE
========================================================= */

document.addEventListener(
    "click",
    (event) => {

        const searchBox =
            $(".search-box");


        const results =
            $("#search-results");


        if (
            searchBox &&
            results &&
            !searchBox.contains(event.target) &&
            !results.contains(event.target)
        ) {

            results.classList.add(
                "hidden"
            );

        }

    }
);


/* =========================================================
   ENTER KEY / ESCAPE
========================================================= */

document.addEventListener(
    "keydown",
    (event) => {

        if (
            event.key ===
            "Escape"
        ) {

            $("#search-results")
                ?.classList
                .add("hidden");


            $("#profile-modal")
                ?.classList
                .add("hidden");

        }

    }
);


/* =========================================================
   BEFORE UNLOAD
========================================================= */

window.addEventListener(
    "beforeunload",
    () => {

        if (state.socket) {

            state.socket.disconnect();

        }

    }
);
