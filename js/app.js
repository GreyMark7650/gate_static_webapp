'use strict';

const stateStore = {
    inputs: {
        bell: false,
        lock: false,
        state: false,
        car: false,
    },
    gate_state: 'unknown',
    last_update: null,
};

const inputElements = {
    bell: document.getElementById('bell-state'),
    lock: document.getElementById('lock-state'),
    state: document.getElementById('state-state'),
    car: document.getElementById('car-state'),
};
const logList = document.querySelector('#event-log ul');
const gateStateEl = document.getElementById('gate-state');
const lastUpdateEl = document.getElementById('last-update');
const overlay = document.getElementById('auth-overlay');
const authForm = document.getElementById('auth-form');
const authStatus = document.getElementById('auth-status');
const sessionUserEl = document.getElementById('session-user');
const sessionRoleEl = document.getElementById('session-role');
const logoutBtn = document.getElementById('logout-btn');

const SESSION_KEY = 'gateRemoteSession';
let session = null;
let eventSource = null;
let sseRetryTimer = null;

document.addEventListener('DOMContentLoaded', () => {
    wireAuth();
    wireControls();
    resumeSession();
});

function wireAuth() {
    authForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const username = document.getElementById('auth-username').value.trim();
        const password = document.getElementById('auth-password').value;
        if (!username || !password) {
            setAuthStatus('Username and password are required');
            return;
        }
        setAuthStatus('Signing in…');
        try {
            const data = await login(username, password);
            applySession(data);
            document.getElementById('auth-username').value = '';
            document.getElementById('auth-password').value = '';
            hideOverlay();
            bootstrapAfterAuth();
        } catch (err) {
            setAuthStatus(err.message || 'Unable to sign in');
        }
    });

    logoutBtn.addEventListener('click', () => {
        appendLog('Signing out');
        teardownSession('Signed out');
    });
}

function wireControls() {
    document.querySelectorAll('.action').forEach((button) => {
        button.disabled = true;
        button.addEventListener('click', async () => {
            const action = button.dataset.action;
            await triggerGateAction(action, button);
        });
    });
}

function resumeSession() {
    const stored = window.sessionStorage.getItem(SESSION_KEY);
    if (!stored) {
        showOverlay();
        return;
    }
    try {
        const parsed = JSON.parse(stored);
        if (!parsed?.token) {
            throw new Error('invalid');
        }
        applySession(parsed, { silent: true });
        hideOverlay();
        bootstrapAfterAuth();
    } catch (_err) {
        window.sessionStorage.removeItem(SESSION_KEY);
        showOverlay();
    }
}

function applySession(data, options = {}) {
    session = {
        token: data.token,
        role: data.role,
        username: data.username,
        expiresAt: data.expiresAt,
    };
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    updateSessionUI();
    updateControlAvailability();
    if (!options.silent) {
        appendLog(`Signed in as ${session.username} (${session.role})`);
    }
}

function teardownSession(message) {
    stopEventStream();
    session = null;
    window.sessionStorage.removeItem(SESSION_KEY);
    updateSessionUI();
    updateControlAvailability();
    showOverlay();
    setAuthStatus(message || 'Session ended');
}

function updateSessionUI() {
    if (session) {
        sessionUserEl.textContent = session.username;
        sessionRoleEl.textContent = session.role;
        sessionRoleEl.dataset.role = session.role;
    } else {
        sessionUserEl.textContent = 'Offline';
        sessionRoleEl.textContent = 'no access';
        sessionRoleEl.dataset.role = 'none';
    }
}

function updateControlAvailability() {
    const isAdmin = session?.role === 'admin';
    document.querySelectorAll('.action').forEach((button) => {
        button.disabled = !isAdmin;
    });
}

async function bootstrapAfterAuth() {
    try {
        await fetchSnapshot();
    } catch (err) {
        appendLog(err.message || 'Failed to load snapshot');
    }
    startEventStream();
}

async function login(username, password) {
    const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    if (!response.ok) {
        const body = await safeJson(response);
        const message = body?.error || 'Invalid credentials';
        throw new Error(message);
    }
    return response.json();
}

async function fetchSnapshot() {
    const response = await fetchWithAuth('/api/state');
    const snapshot = await response.json();
    applySnapshot(snapshot);
}

function startEventStream() {
    stopEventStream();
    if (!session?.token) return;
    const url = `/events?token=${encodeURIComponent(session.token)}`;
    eventSource = new EventSource(url);
    eventSource.onmessage = (event) => {
        const payload = JSON.parse(event.data || '{}');
        if (!payload) return;
        if (payload.ts) updateTimestamp(payload.ts);
        switch (payload.type) {
            case 'snapshot':
                applySnapshot(payload.state);
                break;
            case 'input':
                updateInputCard(payload.input, payload.value);
                break;
            case 'gate_state':
                updateGateState(payload.value);
                break;
            case 'status':
                appendLog(`status → ${payload.value}`);
                break;
            default:
        }
    };

    eventSource.onerror = async () => {
        appendLog('Event stream interrupted — retrying…');
        stopEventStream();
        try {
            await fetchSnapshot();
        } catch (_err) {
            // fetchSnapshot already triggers auth handling
        }
        sseRetryTimer = window.setTimeout(() => startEventStream(), 2500);
    };
}

function stopEventStream() {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
    if (sseRetryTimer) {
        window.clearTimeout(sseRetryTimer);
        sseRetryTimer = null;
    }
}

async function triggerGateAction(action, button) {
    if (!session) {
        appendLog('Sign in required');
        return;
    }
    if (session.role !== 'admin') {
        appendLog('Admin role required for gate commands');
        return;
    }
    button.disabled = true;
    try {
        const response = await fetchWithAuth('/api/gate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
        });
        if (!response.ok) {
            const body = await safeJson(response);
            throw new Error(body?.error || 'Command failed');
        }
        appendLog(`command → ${action}`);
    } catch (err) {
        appendLog(err.message || 'Command failed');
    } finally {
        button.disabled = false;
        updateControlAvailability();
    }
}

async function fetchWithAuth(path, options = {}) {
    if (!session?.token) {
        throw new Error('Not authenticated');
    }
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${session.token}`);
    const init = { ...options, headers };
    const response = await fetch(path, init);
    if (response.status === 401) {
        handleAuthFailure('Session expired');
        throw new Error('Session expired');
    }
    if (response.status === 403) {
        throw new Error('Insufficient permissions');
    }
    return response;
}

function handleAuthFailure(message) {
    appendLog(message);
    teardownSession(message);
}

function applySnapshot(snapshot) {
    if (!snapshot) return;
    Object.entries(snapshot.inputs || {}).forEach(([name, value]) => {
        updateInputCard(name, Boolean(value));
    });
    if (snapshot.gate_state) {
        updateGateState(snapshot.gate_state);
    }
    if (snapshot.last_update) {
        updateTimestamp(snapshot.last_update);
    }
}

function updateInputCard(name, value) {
    stateStore.inputs[name] = value;
    const element = inputElements[name];
    if (!element) return;
    element.textContent = value ? 'ON' : 'OFF';
    const card = element.closest('.input-card');
    if (card) {
        card.dataset.state = value ? 'on' : 'off';
        card.classList.toggle('active', value);
    }
    appendLog(`${name} ${value ? 'HIGH' : 'LOW'}`);
}

function updateGateState(state) {
    stateStore.gate_state = state;
    gateStateEl.textContent = state;
    appendLog(`gate state → ${state}`);
}

function updateTimestamp(unixSeconds) {
    if (!unixSeconds) {
        lastUpdateEl.textContent = 'Awaiting telemetry…';
        return;
    }
    stateStore.last_update = unixSeconds;
    const dt = new Date(unixSeconds * 1000);
    const formatted = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    lastUpdateEl.textContent = `Last signal ${formatted}`;
}

function appendLog(message) {
    if (!logList) return;
    const timestamp = new Date().toLocaleTimeString();
    const entry = document.createElement('li');
    entry.textContent = `[${timestamp}] ${message}`;
    logList.prepend(entry);
    while (logList.children.length > 40) {
        logList.removeChild(logList.lastChild);
    }
}

function showOverlay() {
    overlay.classList.remove('hidden');
}

function hideOverlay() {
    overlay.classList.add('hidden');
    setAuthStatus('');
}

function setAuthStatus(message) {
    authStatus.textContent = message || '';
}

async function safeJson(response) {
    try {
        return await response.json();
    } catch (_err) {
        return null;
    }
}
