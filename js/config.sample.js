window.GATE_REMOTE_CONFIG = {
    // flespi exposes MQTT over secure WebSockets on port 443
    brokerUrl: 'wss://mqtt.flespi.io:443',
    username: 'YOUR_FLESPI_TOKEN',
    password: '',
    clientId: 'wayfinder-remote-web',
    keepalive: 60,
    reconnectPeriod: 2000,
    topics: {
        output: 'gate/output/gate',
        gateState: 'gate/status/gate_state',
        gateMotion: 'gate/status/gate_motion',
        status: 'gate/status',
        inputs: {
            bell: 'gate/input/bell',
            lock: 'gate/input/lock',
            state: 'gate/input/state',
            car: 'gate/input/car',
        },
    },
    // SHA-256 hash (hex) of the passphrase required to unlock command buttons
    commandSecretHash: 'REPLACE_WITH_SHA256_HEX',
};

// Copy this file to js/config.js and commit/deploy only the placeholder version.
