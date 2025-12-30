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

const logList = document.querySelector('#event-log ul');
const gateStateEl = document.getElementById('gate-state');
const lastUpdateEl = document.getElementById('last-update');
const inputElements = {
    bell: document.getElementById('bell-state'),
    lock: document.getElementById('lock-state'),
    state: document.getElementById('state-state'),
    car: document.getElementById('car-state'),
};

let mqttClient = null;
let authorized = false;
let currentConfig = null;

function ensureConfig() {
    if (!window.GATE_REMOTE_CONFIG) {
        throw new Error('GATE_REMOTE_CONFIG missing. Copy js/config.sample.js to js/config.js and fill in your broker/token.');
    }
    const cfg = window.GATE_REMOTE_CONFIG;
    if (!cfg.brokerUrl || !cfg.username) {
        throw new Error('GATE_REMOTE_CONFIG must include brokerUrl and username.');
    }
    return cfg;
}

function connectToBroker(cfg) {
    currentConfig = cfg;
    const clientId = `${cfg.clientId || 'wayfinder-web'}-${Math.random().toString(16).slice(2, 8)}`;
    const options = {
        username: cfg.username,
        password: cfg.password || undefined,
        keepalive: cfg.keepalive ?? 60,
        reconnectPeriod: cfg.reconnectPeriod ?? 2000,
        clean: true,
    };
    appendLog(`connecting → ${cfg.brokerUrl}`);
    mqttClient = mqtt.connect(cfg.brokerUrl, { ...options, clientId });

    mqttClient.on('connect', () => {
        appendLog('connected to MQTT');
        subscribeToTopics(cfg);
    });

    mqttClient.on('reconnect', () => {
        appendLog('reconnecting…');
    });

    mqttClient.on('error', (err) => {
        appendLog(`error: ${err.message}`);
    });

    mqttClient.on('message', (topic, payload) => {
        handleMessage(cfg, topic, payload.toString());
    });
}

function subscribeToTopics(cfg) {
    const topics = new Set();
    Object.values(cfg.topics.inputs || {}).forEach((topic) => topics.add(topic));
    [cfg.topics.gateState, cfg.topics.gateMotion, cfg.topics.status].forEach((topic) => {
        if (topic) topics.add(topic);
    });

    topics.forEach((topic) => {
        mqttClient.subscribe(topic, (err) => {
            if (err) {
                appendLog(`subscribe failed → ${topic}`);
            } else {
                appendLog(`subscribed → ${topic}`);
            }
        });
    });
}

function handleMessage(cfg, topic, payload) {
    const match = resolveTopic(cfg, topic);
    const timestamp = Date.now() / 1000;
    if (!match) {
        appendLog(`message (${topic}) ${payload}`);
        return;
    }

    if (match.type === 'input') {
        const logical = payload.toLowerCase ? ['1', 'true', 'high', 'on'].includes(payload.toLowerCase()) : Boolean(Number(payload));
        stateStore.inputs[match.input] = logical;
        updateInputCard(match.input, logical);
        stateStore.last_update = timestamp;
    } else if (match.type === 'gate_state') {
        updateGateState(payload || 'unknown');
        stateStore.last_update = timestamp;
    } else if (match.type === 'status') {
        appendLog(`status → ${payload}`);
    }
    updateTimestamp(stateStore.last_update);
}

function resolveTopic(cfg, topic) {
    const inputs = cfg.topics.inputs || {};
    for (const [name, t] of Object.entries(inputs)) {
        if (t === topic) {
            return { type: 'input', input: name };
        }
    }
    if (cfg.topics.gateState === topic || cfg.topics.gateMotion === topic) {
        return { type: 'gate_state' };
    }
    if (cfg.topics.status === topic) {
        return { type: 'status' };
    }
    return null;
}

function updateInputCard(name, value) {
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

function wireButtons(cfg) {
    document.querySelectorAll('.action').forEach((button) => {
        button.addEventListener('click', () => {
            const action = button.dataset.action;
            publishGateCommand(cfg, action, button);
        });
        button.disabled = true;
    });
}

function publishGateCommand(cfg, action, button) {
    const commandMap = {
        open: 'on',
        close: 'off',
        toggle: 'toggle',
        pulse: 'toggle',
    };
    const payload = commandMap[action];
    if (!payload) return;
    if (!authorized) {
        appendLog('Unlock required before sending commands');
        return;
    }
    if (!mqttClient || mqttClient.disconnected) {
        appendLog('Cannot send command: MQTT offline');
        return;
    }
    button.disabled = true;
    mqttClient.publish(cfg.topics.output, payload, (err) => {
        button.disabled = false;
        if (err) {
            appendLog(`command error: ${err.message}`);
        } else {
            appendLog(`command → ${action}`);
        }
    });
}

(async function init() {
    try {
        const cfg = ensureConfig();
        await setupAuthOverlay(cfg);
        wireButtons(cfg);
        connectToBroker(cfg);
    } catch (err) {
        alert(err.message);
        console.error(err);
    }
})();

async function setupAuthOverlay(cfg) {
    const overlay = document.getElementById('auth-overlay');
    const form = document.getElementById('auth-form');
    const status = document.getElementById('auth-status');
    if (!cfg.commandSecretHash) {
        overlay.classList.add('hidden');
        authorized = true;
        document.querySelectorAll('.action').forEach((btn) => (btn.disabled = false));
        return;
    }
    const cached = window.localStorage.getItem('gateAuthHash');
    if (cached && cached === cfg.commandSecretHash) {
        overlay.classList.add('hidden');
        authorized = true;
        document.querySelectorAll('.action').forEach((btn) => (btn.disabled = false));
        return;
    }
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        status.textContent = 'Checking…';
        const input = document.getElementById('auth-passphrase');
        const hash = await sha256Hex(input.value || '');
        if (hash === cfg.commandSecretHash) {
            authorized = true;
            overlay.classList.add('hidden');
            document.querySelectorAll('.action').forEach((btn) => (btn.disabled = false));
            window.localStorage.setItem('gateAuthHash', hash);
            status.textContent = '';
            input.value = '';
            appendLog('Controls unlocked');
        } else {
            status.textContent = 'Wrong passphrase';
            input.value = '';
        }
    });
}

async function sha256Hex(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function resetAuth() {
    authorized = false;
    window.localStorage.removeItem('gateAuthHash');
    document.getElementById('auth-overlay').classList.remove('hidden');
    document.querySelectorAll('.action').forEach((btn) => (btn.disabled = true));
}
