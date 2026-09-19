"use strict";

/* =========================================================
   CHATWAVE - MAIN JAVASCRIPT
   Fixed version
   Send Message + Socket + Typing + Calls
========================================================= */


/* =========================================================
   HELPER
========================================================= */

function $(selector) {
    const element = document.querySelector(selector);

    if (!element) {
        console.warn(
            "Element not found:",
            selector
        );
    }

    return element;
}


/* =========================================================
   APPLICATION STATE
========================================================= */

const state = {

    me: null,

    socket: null,

    chats: [],

    messages: new Map(),

    activeChat: null,

    typingActive: false,

    typingTimer: null,

    reconnecting: false,

    pc: null,

    localStream: null,

    remoteStream: null,

    call: null,

    pendingCandidates: [],

    incomingCall: null

};


/* =========================================================
   API HELPER
========================================================= */

async function api(
    url,
    options = {}
) {

    const config = {
        ...options,
        headers: {
            ...(options.body instanceof FormData
                ? {}
                : {
                    "Content-Type":
                        "application/json"
                }),
            ...(options.headers || {})
        }
    };


    const response =
        await fetch(
            url,
            config
        );


    let data = null;

    try {

        data =
            await response.json();

    } catch {

        data = null;

    }


    if (!response.ok) {

        throw new Error(
            data?.error ||
            data?.message ||
            `Request failed: ${response.status}`
        );

    }


    return data;

}


/* =========================================================
   TOAST
========================================================= */

function showToast(
    message,
    type = "info"
) {

    let container =
        document.querySelector(
            "#toast-container"
        );


    if (!container) {

        container =
            document.createElement(
                "div"
            );

        container.id =
            "toast-container";

        container.style.position =
            "fixed";

        container.style.right =
            "20px";

        container.style.bottom =
            "20px";

        container.style.zIndex =
            "99999";

        container.style.display =
            "flex";

        container.style.flexDirection =
            "column";

        container.style.gap =
            "10px";

        document.body.appendChild(
            container
        );

    }


    const toast =
        document.createElement(
            "div"
        );


    toast.textContent =
        String(message || "");


    toast.className =
        `toast toast-${type}`;


    toast.style.padding =
        "12px 16px";

    toast.style.borderRadius =
        "10px";

    toast.style.background =
        "#222";

    toast.style.color =
        "#fff";

    toast.style.maxWidth =
        "320px";

    toast.style.boxShadow =
        "0 8px 30px rgba(0,0,0,.2)";


    container.appendChild(
        toast
    );


    setTimeout(
        () => {

            toast.remove();

        },
        3500
    );

}


/* =========================================================
   HTML ESCAPE
========================================================= */

function escapeHtml(
    value
) {

    return String(
        value ?? ""
    )
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );

}


/* =========================================================
   AVATAR URL
========================================================= */

function avatarUrl(
    user
) {

    if (
        user &&
        user.avatar_url
    ) {

        return user.avatar_url;

    }


    if (
        user &&
        user.profile_photo
    ) {

        return user.profile_photo;

    }


    return (
        "data:image/svg+xml," +
        encodeURIComponent(`
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width="100"
                height="100"
                viewBox="0 0 100 100"
            >
                <rect
                    width="100"
                    height="100"
                    fill="#ddd"
                />
                <circle
                    cx="50"
                    cy="38"
                    r="20"
                    fill="#999"
                />
                <path
                    d="M18 90
                       C20 65 35 55 50 55
                       C65 55 80 65 82 90"
                    fill="#999"
                />
            </svg>
        `)
    );

}


/* =========================================================
   FORMAT TIME
========================================================= */

function formatTime(
    value
) {

    if (!value) {
        return "";
    }


    const date =
        new Date(value);


    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

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


/* =========================================================
   FORMAT DATE
========================================================= */

function formatDate(
    value
) {

    if (!value) {
        return "";
    }


    const date =
        new Date(value);


    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

        return "";

    }


    return date.toLocaleDateString();

}


/* =========================================================
   SOCKET INITIALIZATION
========================================================= */

function initializeSocket() {

    if (
        typeof io !== "function"
    ) {

        console.error(
            "Socket.IO library load nahi hui."
        );

        showToast(
            "Socket.IO load nahi hui.",
            "error"
        );

        return;

    }


    if (state.socket) {

        try {

            state.socket.disconnect();

        } catch {

            // Ignore old socket error

        }

    }


    state.socket =
        io(
            window.location.origin,
            {
                transports: [
                    "websocket",
                    "polling"
                ],

                reconnection: true,

                reconnectionAttempts:
                    Infinity,

                reconnectionDelay:
                    1000,

                reconnectionDelayMax:
                    5000,

                timeout:
                    20000
            }
        );


    /* =====================================================
       CONNECT
    ====================================================== */

    state.socket.on(
        "connect",
        () => {

            console.log(
                "Socket connected:",
                state.socket.id
            );


            state.reconnecting =
                false;


            showToast(
                "Server connected",
                "success"
            );

        }
    );


    /* =====================================================
       DISCONNECT
    ====================================================== */

    state.socket.on(
        "disconnect",
        (reason) => {

            console.warn(
                "Socket disconnected:",
                reason
            );


            state.reconnecting =
                true;

        }
    );


    /* =====================================================
       CONNECT ERROR
    ====================================================== */

    state.socket.on(
        "connect_error",
        (error) => {

            state.reconnecting =
                true;


            console.error(
                "Socket connection error:",
                error
            );

        }
    );


    /* =====================================================
       NEW MESSAGE
    ====================================================== */

    state.socket.on(
        "message:new",
        (message) => {

            handleNewMessage(
                message
            );

        }
    );


    /* =====================================================
       MESSAGE STATUS
    ====================================================== */

    state.socket.on(
        "message:status",
        (data) => {

            handleMessageStatus(
                data
            );

        }
    );


    /* =====================================================
       TYPING UPDATE
    ====================================================== */

    state.socket.on(
        "typing:update",
        (data) => {

            handleTyping(
                data
            );

        }
    );


    /* =====================================================
       PRESENCE
    ====================================================== */

    state.socket.on(
        "presence:update",
        (data) => {

            handlePresence(
                data
            );

        }
    );


    /* =====================================================
       INCOMING CALL
    ====================================================== */

    state.socket.on(
        "call:start",
        (data) => {

            handleIncomingCall(
                data
            );

        }
    );


    /* =====================================================
       CALL ACCEPTED
    ====================================================== */

    state.socket.on(
        "call:accept",
        async (data) => {

            await handleCallAccepted(
                data
            );

        }
    );


    /* =====================================================
       CALL REJECTED
    ====================================================== */

    state.socket.on(
        "call:reject",
        (data) => {

            handleCallRejected(
                data
            );

        }
    );


    /* =====================================================
       CALL ENDED
    ====================================================== */

    state.socket.on(
        "call:end",
        (data) => {

            handleCallEnded(
                data
            );

        }
    );


    /* =====================================================
       WEBRTC OFFER
    ====================================================== */

    state.socket.on(
        "webrtc:offer",
        async (data) => {

            await handleWebRTCOffer(
                data
            );

        }
    );


    /* =====================================================
       WEBRTC ANSWER
    ====================================================== */

    state.socket.on(
        "webrtc:answer",
        async (data) => {

            await handleWebRTCAnswer(
                data
            );

        }
    );


    /* =====================================================
       WEBRTC ICE
    ====================================================== */

    state.socket.on(
        "webrtc:ice",
        async (data) => {

            await handleWebRTCIce(
                data
            );

        }
    );

}


/* =========================================================
   HANDLE NEW MESSAGE
========================================================= */

function handleNewMessage(
    message
) {

    if (!message) {
        return;
    }


    const conversationId =
        message.conversation_id;


    if (!conversationId) {
        return;
    }


    let list =
        state.messages.get(
            conversationId
        );


    if (!list) {

        list = [];

        state.messages.set(
            conversationId,
            list
        );

    }


    const alreadyExists =
        list.some(
            (item) =>
                item.id === message.id
        );


    if (!alreadyExists) {

        list.push(
            message
        );

    }


    const chat =
        state.chats.find(
            (item) =>
                item.conversation_id ===
                conversationId
        );


    if (chat) {

        chat.last_message =
            message;


        if (
            message.sender_id !==
                state.me?.id &&
            (
                !state.activeChat ||
                state.activeChat.conversation_id !==
                    conversationId
            )
        ) {

            chat.unread_count =
                (
                    chat.unread_count ||
                    0
                ) + 1;

        }

    }


    if (
        state.activeChat &&
        state.activeChat.conversation_id ===
            conversationId
    ) {

        renderMessages();


        if (
            message.receiver_id ===
            state.me?.id
        ) {

            markRead();

        }

    }


    renderChatList();


    if (
        message.sender_id !==
            state.me?.id &&
        (
            !state.activeChat ||
            state.activeChat.conversation_id !==
                conversationId
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

function handleMessageStatus(
    data
) {

    if (!data) {
        return;
    }


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
                state.activeChat
                    .conversation_id
        }
    );


    const chat =
        state.chats.find(
            (item) =>
                item.conversation_id ===
                state.activeChat
                    .conversation_id
        );


    if (chat) {

        chat.unread_count =
            0;

    }


    renderChatList();

}


/* =========================================================
   SEND MESSAGE - FIXED
========================================================= */

function sendMessage() {

    const input =
        $("#message-input");


    if (!input) {
        return;
    }


    const text =
        input.value.trim();


    if (!text) {
        return;
    }


    if (!state.activeChat) {

        showToast(
            "Pehle chat select karo.",
            "error"
        );

        return;

    }


    if (
        !state.socket
    ) {

        showToast(
            "Server connection nahi hai.",
            "error"
        );

        initializeSocket();

        return;

    }


    if (
        !state.socket.connected
    ) {

        showToast(
            "Server se connection nahi hai. Reconnecting...",
            "error"
        );


        try {

            state.socket.connect();

        } catch (error) {

            console.error(
                "Socket reconnect error:",
                error
            );

        }

        return;

    }


    const receiverId =
        state.activeChat
            ?.user
            ?.id;


    if (!receiverId) {

        showToast(
            "Receiver user ID nahi mili.",
            "error"
        );

        console.error(
            "Invalid active chat:",
            state.activeChat
        );

        return;

    }


    const payload = {

        receiver_id:
            receiverId,

        message:
            text

    };


    console.log(
        "Sending message:",
        payload
    );


    state.socket.emit(
        "chat:send",
        payload,
        (response) => {

            console.log(
                "chat:send response:",
                response
            );


            if (
                response &&
                response.error
            ) {

                showToast(
                    response.error,
                    "error"
                );

                return;

            }

        }
    );


    input.value =
        "";


    input.focus();


    stopTyping();

}


/* =========================================================
   MESSAGE FORM
========================================================= */

function initializeMessageForm() {

    const form =
        $("#message-form");


    if (!form) {

        console.warn(
            "#message-form nahi mila."
        );

        return;

    }


    form.addEventListener(
        "submit",
        (event) => {

            event.preventDefault();

            event.stopPropagation();

            sendMessage();

        }
    );

}


/* =========================================================
   TYPING INPUT
========================================================= */

function initializeTyping() {

    const input =
        $("#message-input");


    if (!input) {
        return;
    }


    input.addEventListener(
        "input",
        () => {

            if (
                !state.activeChat ||
                !state.socket ||
                !state.socket.connected
            ) {

                return;

            }


            if (
                !state.typingActive
            ) {

                state.typingActive =
                    true;


                state.socket.emit(
                    "typing:start",
                    {
                        receiver_id:
                            state.activeChat
                                .user
                                .id
                    }
                );

            }


            clearTimeout(
                state.typingTimer
            );


            state.typingTimer =
                setTimeout(
                    () => {

                        stopTyping();

                    },
                    1000
                );

        }
    );

}


/* =========================================================
   STOP TYPING
========================================================= */

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
                    state.activeChat
                        .user
                        .id
            }
        );

    }


    state.typingActive =
        false;


    clearTimeout(
        state.typingTimer
    );

}


/* =========================================================
   HANDLE TYPING
========================================================= */

function handleTyping(
    data
) {

    if (
        !state.activeChat ||
        !data
    ) {

        return;

    }


    if (
        data.conversation_id !==
        state.activeChat
            .conversation_id
    ) {

        return;

    }


    const typingBar =
        $("#typing-bar");


    if (!typingBar) {
        return;
    }


    typingBar.classList.toggle(
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

                    typingBar
                        .classList
                        .add(
                            "hidden"
                        );

                },
                2500
            );

    }

}


/* =========================================================
   PRESENCE
========================================================= */

function handlePresence(
    data
) {

    if (!data) {
        return;
    }


    const chat =
        state.chats.find(
            (item) =>
                item.user &&
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
        state.activeChat.user &&
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
   WEBRTC CONFIG
========================================================= */

const RTC_CONFIG = {

    iceServers: [

        {
            urls:
                "stun:stun.l.google.com:19302"
        },

        {
            urls:
                "stun:stun1.l.google.com:19302"
        }

    ]

};


/* =========================================================
   CREATE PEER CONNECTION
========================================================= */

function createPeerConnection() {

    if (state.pc) {

        try {

            state.pc.close();

        } catch {

            // Ignore

        }

    }


    state.pendingCandidates =
        [];


    const pc =
        new RTCPeerConnection(
            RTC_CONFIG
        );


    state.pc =
        pc;


    pc.onicecandidate =
        (event) => {

            if (
                !event.candidate ||
                !state.socket ||
                !state.socket.connected ||
                !state.call
            ) {

                return;

            }


            state.socket.emit(
                "webrtc:ice",
                {

                    call_id:
                        state.call.call_id,

                    candidate:
                        event.candidate

                }
            );

        };


    pc.ontrack =
        (event) => {

            const video =
                $("#remote-video");


            if (!video) {
                return;
            }


            if (
                !state.remoteStream
            ) {

                state.remoteStream =
                    new MediaStream();

            }


            state.remoteStream.addTrack(
                event.track
            );


            video.srcObject =
                state.remoteStream;


            video.autoplay =
                true;

            video.playsInline =
                true;


            const playPromise =
                video.play();


            if (
                playPromise &&
                typeof playPromise.catch ===
                    "function"
            ) {

                playPromise.catch(
                    () => {}
                );

            }

        };


    pc.onconnectionstatechange =
        () => {

            console.log(
                "WebRTC connection:",
                pc.connectionState
            );


            if (
                pc.connectionState ===
                    "connected"
            ) {

                showToast(
                    "Call connected",
                    "success"
                );

            }


            if (
                pc.connectionState ===
                    "failed"
            ) {

                showToast(
                    "Call connection failed.",
                    "error"
                );

            }

        };


    return pc;

}


/* =========================================================
   START CALL
========================================================= */

async function startCall(
    type
) {

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
        state.pc ||
        state.localStream
    ) {

        endCallLocal();

    }


    if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
    ) {

        showToast(
            "Camera/microphone browser mein supported nahi hai.",
            "error"
        );

        return;

    }


    try {

        state.localStream =
            await navigator.mediaDevices
                .getUserMedia(
                    {

                        audio:
                            true,

                        video:
                            type ===
                            "video"

                    }
                );


        const localVideo =
            $("#local-video");


        if (localVideo) {

            localVideo.srcObject =
                state.localStream;

            localVideo.muted =
                true;

            localVideo.autoplay =
                true;

            localVideo.playsInline =
                true;

        }


        state.call = {

            call_id:
                null,

            type:
                type,

            role:
                "caller",

            peer_id:
                state.activeChat
                    .user
                    .id

        };


        showCallUI(
            type,
            false
        );


        state.socket.emit(
            "call:start",
            {

                receiver_id:
                    state.activeChat
                        .user
                        .id,

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
            "Camera/microphone permission required hai.",
            "error"
        );


        endCallLocal();

    }

}


/* =========================================================
   HANDLE INCOMING CALL
========================================================= */

function handleIncomingCall(
    data
) {

    if (!data) {
        return;
    }


    state.incomingCall =
        data;


    state.call = {

        call_id:
            data.call_id,

        type:
            data.call_type ||
            "voice",

        role:
            "receiver",

        peer_id:
            data.caller_id

    };


    showIncomingCallUI(
        data
    );

}


/* =========================================================
   ACCEPT CALL
========================================================= */

async function acceptCall() {

    if (
        !state.incomingCall ||
        !state.socket ||
        !state.socket.connected
    ) {

        return;

    }


    const data =
        state.incomingCall;


    try {

        state.localStream =
            await navigator.mediaDevices
                .getUserMedia(
                    {

                        audio:
                            true,

                        video:
                            data.call_type ===
                            "video"

                    }
                );


        const localVideo =
            $("#local-video");


        if (localVideo) {

            localVideo.srcObject =
                state.localStream;

            localVideo.muted =
                true;

            localVideo.autoplay =
                true;

            localVideo.playsInline =
                true;

        }


        state.call = {

            call_id:
                data.call_id,

            type:
                data.call_type ||
                "voice",

            role:
                "receiver",

            peer_id:
                data.caller_id

        };


        createPeerConnection();


        state.localStream
            .getTracks()
            .forEach(
                (track) => {

                    state.pc.addTrack(
                        track,
                        state.localStream
                    );

                }
            );


        state.socket.emit(
            "call:accept",
            {

                call_id:
                    data.call_id

            }
        );


        state.incomingCall =
            null;


        showCallUI(
            state.call.type,
            false
        );


    } catch (error) {

        console.error(
            "Accept call error:",
            error
        );


        showToast(
            "Camera/microphone permission required hai.",
            "error"
        );


        rejectCall();

    }

}


/* =========================================================
   REJECT CALL
========================================================= */

function rejectCall() {

    if (
        state.socket &&
        state.socket.connected &&
        state.incomingCall
    ) {

        state.socket.emit(
            "call:reject",
            {

                call_id:
                    state.incomingCall
                        .call_id

            }
        );

    }


    state.incomingCall =
        null;

    state.call =
        null;


    hideCallUI();

}


/* =========================================================
   HANDLE CALL ACCEPTED
========================================================= */

async function handleCallAccepted(
    data
) {

    if (
        !state.call ||
        !data ||
        state.call.call_id !==
            data.call_id
    ) {

        return;

    }


    try {

        const pc =
            createPeerConnection();


        if (state.localStream) {

            state.localStream
                .getTracks()
                .forEach(
                    (track) => {

                        pc.addTrack(
                            track,
                            state.localStream
                        );

                    }
                );

        }


        await makeOffer();

    } catch (error) {

        console.error(
            "Call accepted error:",
            error
        );


        showToast(
            "Call start nahi ho saki.",
            "error"
        );

    }

}


/* =========================================================
   MAKE OFFER
========================================================= */

async function makeOffer() {

    if (
        !state.pc ||
        !state.call ||
        !state.socket ||
        !state.socket.connected
    ) {

        return;

    }


    try {

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
                    state.pc
                        .localDescription

            }
        );


    } catch (error) {

        console.error(
            "Create offer error:",
            error
        );

    }

}


/* =========================================================
   HANDLE WEBRTC OFFER
========================================================= */

async function handleWebRTCOffer(
    data
) {

    if (
        !data ||
        !state.call ||
        !state.socket ||
        !state.socket.connected
    ) {

        return;

    }


    if (
        state.call.call_id !==
        data.call_id
    ) {

        return;

    }


    try {

        if (!state.pc) {

            createPeerConnection();

        }


        if (
            state.localStream &&
            state.pc.getSenders().length ===
                0
        ) {

            state.localStream
                .getTracks()
                .forEach(
                    (track) => {

                        state.pc.addTrack(
                            track,
                            state.localStream
                        );

                    }
                );

        }


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
                    state.call.call_id,

                answer:
                    state.pc
                        .localDescription

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


/* =========================================================
   HANDLE WEBRTC ANSWER
========================================================= */

async function handleWebRTCAnswer(
    data
) {

    if (
        !state.pc ||
        !state.call
    ) {

        return;

    }


    if (
        state.call.call_id !==
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


/* =========================================================
   HANDLE WEBRTC ICE
========================================================= */

async function handleWebRTCIce(
    data
) {

    if (
        !state.call ||
        !data ||
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
                .push(
                    candidate
                );

        }

    } catch (error) {

        console.warn(
            "ICE candidate error:",
            error
        );

    }

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
        [
            ...state.pendingCandidates
        ];


    state.pendingCandidates =
        [];


    for (
        const candidate of candidates
    ) {

        try {

            await state.pc
                .addIceCandidate(
                    candidate
                );

        } catch (error) {

            console.warn(
                "ICE flush error:",
                error
            );

        }

    }

}


/* =========================================================
   CALL REJECTED
========================================================= */

function handleCallRejected(
    data
) {

    console.log(
        "Call rejected:",
        data
    );


    showToast(
        "Call rejected.",
        "error"
    );


    endCallLocal();

}


/* =========================================================
   CALL ENDED
========================================================= */

function handleCallEnded(
    data
) {

    console.log(
        "Call ended:",
        data
    );


    endCallLocal();

}


/* =========================================================
   END CALL LOCAL
========================================================= */

function endCallLocal() {

    if (
        state.localStream
    ) {

        state.localStream
            .getTracks()
            .forEach(
                (track) => {

                    try {

                        track.stop();

                    } catch {

                        // Ignore

                    }

                }
            );

    }


    state.localStream =
        null;


    state.remoteStream =
        null;


    if (state.pc) {

        try {

            state.pc.close();

        } catch {

            // Ignore

        }

    }


    state.pc =
        null;


    state.pendingCandidates =
        [];


    state.call =
        null;


    state.incomingCall =
        null;


    const localVideo =
        $("#local-video");


    if (localVideo) {

        localVideo.srcObject =
            null;

    }


    const remoteVideo =
        $("#remote-video");


    if (remoteVideo) {

        remoteVideo.srcObject =
            null;

    }


    hideCallUI();

}


/* =========================================================
   END CALL
========================================================= */

function endCall() {

    if (
        state.socket &&
        state.socket.connected &&
        state.call
    ) {

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


/* =========================================================
   SHOW CALL UI
========================================================= */

function showCallUI(
    type,
    incoming = false
) {

    const modal =
        $("#call-modal");


    if (modal) {

        modal.classList.remove(
            "hidden"
        );

    }


    const status =
        $("#call-status");


    if (status) {

        status.textContent =
            incoming
                ? "Incoming call..."
                : `${type === "video" ? "Video" : "Voice"} call...`;

    }

}


/* =========================================================
   HIDE CALL UI
========================================================= */

function hideCallUI() {

    const modal =
        $("#call-modal");


    if (modal) {

        modal.classList.add(
            "hidden"
        );

    }

}


/* =========================================================
   INCOMING CALL UI
========================================================= */

function showIncomingCallUI(
    data
) {

    showCallUI(
        data.call_type ||
            "voice",
        true
    );


    const name =
        $("#incoming-call-name");


    if (name) {

        name.textContent =
            data.caller_name ||
            "Incoming call";

    }


    const accept =
        $("#accept-call-btn");


    if (accept) {

        accept.onclick =
            () => {

                acceptCall();

            };

    }


    const reject =
        $("#reject-call-btn");


    if (reject) {

        reject.onclick =
            () => {

                rejectCall();

            };

    }

}


/* =========================================================
   CALL BUTTONS
========================================================= */

function initializeCallButtons() {

    const voiceButton =
        $("#voice-call-btn");


    if (voiceButton) {

        voiceButton.addEventListener(
            "click",
            () => {

                startCall(
                    "voice"
                );

            }
        );

    }


    const videoButton =
        $("#video-call-btn");


    if (videoButton) {

        videoButton.addEventListener(
            "click",
            () => {

                startCall(
                    "video"
                );

            }
        );

    }


    const endButton =
        $("#end-call-btn");


    if (endButton) {

        endButton.addEventListener(
            "click",
            () => {

                endCall();

            }
        );

    }

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
            Array.isArray(
                data.chats
            )
                ? data.chats
                : [];


        renderChatList();

    } catch (error) {

        console.error(
            "Load chats error:",
            error
        );


        showToast(
            error.message,
            "error"
        );

    }

}


/* =========================================================
   LOAD MESSAGES
========================================================= */

async function loadMessages(
    conversationId
) {

    if (!conversationId) {
        return;
    }


    try {

        const data =
            await api(
                `/api/messages/${encodeURIComponent(
                    conversationId
                )}`
            );


        const messages =
            Array.isArray(
                data.messages
            )
                ? data.messages
                : [];


        state.messages.set(
            conversationId,
            messages
        );


        renderMessages();


    } catch (error) {

        console.error(
            "Load messages error:",
            error
        );


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


    if (!element) {
        return;
    }


    if (!state.chats.length) {

        element.innerHTML = `
            <div
                class="muted"
                style="
                    padding:24px;
                    text-align:center;
                    line-height:1.6;
                "
            >
                No chats yet.<br>
                Search a username above.
            </div>
        `;

        return;

    }


    element.innerHTML =
        state.chats
            .map(
                (chat) => {

                    const active =
                        state.activeChat &&
                        state.activeChat
                            .conversation_id ===
                        chat.conversation_id;


                    const last =
                        chat.last_message;


                    const user =
                        chat.user || {};


                    return `
                        <div
                            class="chat-item ${
                                active
                                    ? "active"
                                    : ""
                            }"
                            data-id="${
                                escapeHtml(
                                    chat.conversation_id
                                )
                            }"
                        >

                            <img
                                class="avatar"
                                src="${escapeHtml(
                                    avatarUrl(
                                        user
                                    )
                                )}"
                                alt=""
                            >

                            <div class="chat-meta">

                                <div class="chat-top">

                                    <span
                                        class="chat-name"
                                    >
                                        ${escapeHtml(
                                            user.display_name ||
                                            user.username ||
                                            "User"
                                        )}
                                    </span>

                                    <span
                                        class="chat-time"
                                    >
                                        ${
                                            last
                                                ? formatTime(
                                                    last.created_at
                                                )
                                                : ""
                                        }
                                    </span>

                                </div>

                                <div
                                    class="chat-preview"
                                >
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
                                        <span
                                            class="badge"
                                        >
                                            ${
                                                chat.unread_count >
                                                99
                                                    ? "99+"
                                                    : chat.unread_count
                                            }
                                        </span>
                                    `
                                    : ""
                            }

                        </div>
                    `;

                }
            )
            .join("");


    element
        .querySelectorAll(
            ".chat-item"
        )
        .forEach(
            (item) => {

                item.addEventListener(
                    "click",
                    () => {

                        const id =
                            item.dataset.id;


                        openChat(
                            id
                        );

                    }
                );

            }
        );

}


/* =========================================================
   OPEN CHAT
========================================================= */

async function openChat(
    conversationId
) {

    const chat =
        state.chats.find(
            (item) =>
                String(
                    item.conversation_id
                ) ===
                String(
                    conversationId
                )
        );


    if (!chat) {

        console.warn(
            "Chat not found:",
            conversationId
        );

        return;

    }


    state.activeChat =
        chat;


    renderChatList();

    renderChatHeader();


    const appView =
        $("#app-view");


    if (appView) {

        appView.classList.add(
            "chat-open"
        );

    }


    const activeChat =
        $("#active-chat");


    if (activeChat) {

        activeChat.classList.remove(
            "hidden"
        );

    }


    const emptyChat =
        $("#empty-chat");


    if (emptyChat) {

        emptyChat.classList.add(
            "hidden"
        );

    }


    await loadMessages(
        chat.conversation_id
    );


    markRead();

}


/* =========================================================
   RENDER CHAT HEADER
========================================================= */

function renderChatHeader() {

    if (!state.activeChat) {
        return;
    }


    const user =
        state.activeChat.user || {};


    const name =
        $("#chat-header-name");


    if (name) {

        name.textContent =
            user.display_name ||
            user.username ||
            "User";

    }


    const avatar =
        $("#chat-header-avatar");


    if (avatar) {

        avatar.src =
            avatarUrl(
                user
            );

    }


    const status =
        $("#chat-header-status");


    if (status) {

        if (user.online) {

            status.textContent =
                "Online";

        } else {

            status.textContent =
                user.last_seen
                    ? `Last seen ${formatDate(
                        user.last_seen
                    )}`
                    : "Offline";

        }

    }

}


/* =========================================================
   RENDER MESSAGES
========================================================= */

function renderMessages() {

    if (!state.activeChat) {
        return;
    }


    const container =
        $("#messages");


    if (!container) {
        return;
    }


    const list =
        state.messages.get(
            state.activeChat
                .conversation_id
        ) || [];


    if (!list.length) {

        container.innerHTML = `
            <div
                class="muted"
                style="
                    text-align:center;
                    padding:30px;
                "
            >
                No messages yet.
            </div>
        `;

        return;

    }


    container.innerHTML =
        list
            .map(
                (message) => {

                    const mine =
                        String(
                            message.sender_id
                        ) ===
                        String(
                            state.me?.id
                        );


                    let tick =
                        "✓";


                    if (
                        message.read_at
                    ) {

                        tick =
                            "✓✓";

                    } else if (
                        message.delivered_at
                    ) {

                        tick =
                            "✓✓";

                    }


                    return `
                        <div
                            class="message-row ${
                                mine
                                    ? "sent"
                                    : "received"
                            }"
                        >

                            <div
                                class="message-bubble"
                            >

                                <div
                                    class="message-text"
                                >
                                    ${escapeHtml(
                                        message.message
                                    )}
                                </div>

                                <div
                                    class="message-time"
                                >

                                    ${formatTime(
                                        message.created_at
                                    )}

                                    ${
                                        mine
                                            ? `
                                                <span
                                                    class="${
                                                        message.read_at
                                                            ? "read"
                                                            : ""
                                                    }"
                                                >
                                                    ${tick}
                                                </span>
                                            `
                                            : ""
                                    }

                                </div>

                            </div>

                        </div>
                    `;

                }
            )
            .join("");


    container.scrollTop =
        container.scrollHeight;

}


/* =========================================================
   SEARCH USER
========================================================= */

async function searchUsers(
    query
) {

    const text =
        String(
            query || ""
        ).trim();


    if (!text) {
        return [];
    }


    try {

        const data =
            await api(
                `/api/users/search?q=${encodeURIComponent(
                    text
                )}`
            );


        return Array.isArray(
            data.users
        )
            ? data.users
            : [];

    } catch (error) {

        console.error(
            "Search users error:",
            error
        );


        showToast(
            error.message,
            "error"
        );


        return [];

    }

}


/* =========================================================
   SEARCH UI
========================================================= */

function initializeSearch() {

    const input =
        $("#search-input");


    if (!input) {
        return;
    }


    let timer =
        null;


    input.addEventListener(
        "input",
        () => {

            clearTimeout(
                timer
            );


            timer =
                setTimeout(
                    async () => {

                        const users =
                            await searchUsers(
                                input.value
                            );


                        renderSearchResults(
                            users
                        );

                    },
                    300
                );

        }
    );

}


/* =========================================================
   RENDER SEARCH RESULTS
========================================================= */

function renderSearchResults(
    users
) {

    const container =
        $("#search-results");


    if (!container) {
        return;
    }


    if (!users.length) {

        container.innerHTML =
            "";

        return;

    }


    container.innerHTML =
        users
            .map(
                (user) => `

                    <div
                        class="search-result"
                        data-user-id="${
                            escapeHtml(
                                user.id
                            )
                        }"
                    >

                        <img
                            class="avatar"
                            src="${escapeHtml(
                                avatarUrl(
                                    user
                                )
                            )}"
                            alt=""
                        >

                        <div>

                            <div>
                                ${escapeHtml(
                                    user.display_name ||
                                    user.username ||
                                    "User"
                                )}
                            </div>

                            <small>
                                @${escapeHtml(
                                    user.username ||
                                    ""
                                )}
                            </small>

                        </div>

                    </div>

                `
            )
            .join("");


    container
        .querySelectorAll(
            ".search-result"
        )
        .forEach(
            (element) => {

                element.addEventListener(
                    "click",
                    () => {

                        const userId =
                            element.dataset
                                .userId;


                        startNewChat(
                            userId
                        );

                    }
                );

            }
        );

}


/* =========================================================
   START NEW CHAT
========================================================= */

async function startNewChat(
    userId
) {

    if (!userId) {
        return;
    }


    try {

        const data =
            await api(
                "/api/chats",
                {

                    method:
                        "POST",

                    body:
                        JSON.stringify(
                            {
                                user_id:
                                    userId
                            }
                        )

                }
            );


        if (
            data.chat
        ) {

            const existing =
                state.chats.find(
                    (chat) =>
                        chat.conversation_id ===
                        data.chat
                            .conversation_id
                );


            if (!existing) {

                state.chats.unshift(
                    data.chat
                );

            }


            renderChatList();


            await openChat(
                data.chat
                    .conversation_id
            );

        }


    } catch (error) {

        console.error(
            "Start chat error:",
            error
        );


        showToast(
            error.message,
            "error"
        );

    }

}


/* =========================================================
   INITIALIZATION
========================================================= */

async function initializeApp() {

    console.log(
        "ChatWave initializing..."
    );


    try {

        const data =
            await api(
                "/api/me"
            );


        state.me =
            data.user ||
            data.me ||
            null;


    } catch (error) {

        console.error(
            "User load error:",
            error
        );

    }


    initializeSocket();

    initializeMessageForm();

    initializeTyping();

    initializeCallButtons();

    initializeSearch();


    try {

        await loadChats();

    } catch {

        // Already handled

    }


    console.log(
        "ChatWave initialized."
    );

}


/* =========================================================
   DOM READY
========================================================= */

if (
    document.readyState ===
    "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        () => {

            initializeApp();

        },
        {
            once: true
        }
    );

} else {

    initializeApp();

}


/* =========================================================
   BEFORE UNLOAD
========================================================= */

window.addEventListener(
    "beforeunload",
    () => {

        try {

            endCallLocal();

        } catch {

            // Ignore

        }


        if (state.socket) {

            try {

                state.socket.disconnect();

            } catch {

                // Ignore

            }

        }

    }
);