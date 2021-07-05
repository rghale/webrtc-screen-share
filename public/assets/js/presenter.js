export default class presenter {

    constructor(options = {}) {
        this.sharingStream = { display: null, audio: null };
        this.sharingOptions = {
            mechanism: 'distributed',
            maxFrameRate: 20,
            microphone: 'muted',
            screenSize: [800, 600],
        };
        this.nodePort = window.location.port;
        this.socket = null;
        this.peerConnection = null;
        this.viewers = {};
        this.isConnected = false;
        this.iceServers = options.iceServers;
        if (options.mechanism) {
            this.sharingOptions.mechanism = options.mechanism;
        }
        this.validPresenter = true;
        this.status = {};
        this.webRtcPeer = null;
        this.init();
    }

    init() {
        var script = document.createElement('script');
        script.setAttribute("src", window.location.protocol + "//" + window.location.hostname + ":" + this.nodePort + "/socket.io/socket.io.js");
        script.onload = () => {
            this.registerNodeEvents();
        };
        document.head.appendChild(script);
    }

    registerNodeEvents() {
        let sessionId = (new URLSearchParams(window.location.search)).get("session_id");
        this.socket = io.connect(window.location.protocol + "//" + window.location.hostname + ":" + this.nodePort, { query: 'session_id=' + sessionId });

        this.socket.on("connect", () => {
            this.viewers = {};
            this.socket.emit("registerPresenter", (result) => {
                this.socket.emit("setMechanism", this.sharingOptions.mechanism);
                if (!result) {
                    this.validPresenter = false;
                    console.error("Another presenter running");
                    this.onStatusChanged();
                    return;
                }
                if (this.status.pauseOnDisconnect) {
                    let tracks = this.getTracks();
                    if (tracks[0]) {
                        this.status.pauseOnDisconnect = false;
                        tracks[0].enabled = true;
                        this.socket.emit("presenterStartSharing");
                    }
                }
            });
            this.isConnected = true;
            this.onStatusChanged();
        });

        this.socket.on("disconnect", () => {
            this.isConnected = false;
            let tracks = this.getTracks();
            if (tracks[0]) {
                if (tracks[0].enabled) {
                    this.status.pauseOnDisconnect = true;
                    tracks[0].enabled = false;
                }
            }
            this.onStatusChanged();
        })

        this.socket.on("sendExistingViewers", (viewers) => {
            if (this.sharingOptions.mechanism == 'streamserver') {
                return;
            }
            viewers.forEach(viewer => {
                this.viewers[viewer.id] = viewer;
                this.createPeerConnection(viewer);
            });
            this.onStatusChanged();
        });

        this.socket.on("viewerRegistered", (viewer) => {
            this.viewers[viewer.id] = viewer;
            if (this.sharingOptions.mechanism == 'streamserver') {
                this.onStatusChanged();
                return;
            }
            if (viewer.sender == this.socket.id) {
                this.createPeerConnection(viewer);
            }
            else {
                this.socket.emit("senderCreatePeerConnection", { viewer: viewer.id, sender: viewer.sender });
            }
            this.onStatusChanged();
        });

        this.socket.on("viewerLeave", (viewer) => {
            delete this.viewers[viewer.id];
            this.onStatusChanged();
        });

        this.socket.on("sendViewerOffer", (data) => {
            if (this.sharingOptions.mechanism == 'streamserver') {
                return;
            }
            this.viewers[data.id].peerConnection.setRemoteDescription(data.offer);
        });

        this.socket.on("sendViewerCandidate", (data) => {
            if (this.sharingOptions.mechanism == 'streamserver') {
                return;
            }
            this.viewers[data.id].peerConnection.addIceCandidate(data.candidate)
        });

        this.socket.on("streamserverPresenterAvailable", () => {
            this.socket.emit("presenterStartSharing");
        });

        this.socket.on("message", (message) => {
            var parsedMessage = JSON.parse(message);

            switch (parsedMessage.id) {
                case 'presenterResponse':
                    this.presenterResponse(parsedMessage);
                    break;
                case 'stopCommunication':
                    this.dispose();
                    break;
                case 'iceCandidate':
                    this.webRtcPeer.addIceCandidate(parsedMessage.candidate)
                    break;
                default:
                    console.error('Unrecognized message', parsedMessage);
            }
        });
    }

    async startSharing(options, startEvent, stopEvent, failedEvent) {
        if (!options) {
            options = {};
        }
        if (options.screenSize) {
            options.screenSize = options.screenSize.split("*");
        }
        this.sharingOptions = { ...this.sharingOptions, ...options };
        let displayMediaOptions = {
            video: {
                width: { max: this.sharingOptions.screenSize[0] },
                height: { max: this.sharingOptions.screenSize[1] },
                frameRate: {
                    max: this.sharingOptions.maxFrameRate
                }
            },
            audio: true
        };
        let audioMediaOptions = {
            video: false,
            audio: true
        };
        try {
            this.sharingStream.display = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
        }
        catch (err) {
            if (failedEvent) {
                failedEvent.call(err.toString());
            }
            console.error("Error: " + err);
            this.socket.emit("presenterStopSharing");
            this.stop();
            return false;
        }
        if (!this.sharingStream.display) {
            failedEvent.call("Unknown exception");
            this.socket.emit("presenterStopSharing");
            this.stop();
            return false;
        }
        try {
            this.sharingStream.audio = await navigator.mediaDevices.getUserMedia(audioMediaOptions);
        }
        catch (err) {

        }
        if (startEvent) {
            startEvent.call();
        }

        let tracks = this.getTracks();
        tracks.forEach(track => {
            if (track.kind == "video") {
                track.addEventListener('ended', () => {
                    Object.keys(this.viewers).forEach(id => {
                        this.viewers[id].sharedStream = false;
                    });
                    let tracks = this.getTracks();
                    tracks.forEach(track => {
                        if (track.kind == "audio") {
                            track.enabled = false;
                            track.stop();
                        }
                    });
                    this.sharingStream.display = null;
                    this.sharingStream.audio = null;
                    this.socket.emit("presenterStopSharing");
                    if (stopEvent) {
                        stopEvent.call();
                    }
                    this.stop();
                });
            }
        });
        if (this.sharingOptions.mechanism == 'streamserver') {
            this.presenter();
        }
        else {
            Object.keys(this.viewers).forEach(id => {
                if (!this.viewers[id].sharedStream && this.viewers[id].peerConnection) {
                    this.viewers[id].sharedStream = true;
                    this.viewers[id].senders = this.viewers[id].senders ? this.viewers[id].senders : [];
                    let sendersLength = this.viewers[id].senders.length;
                    tracks.forEach(track => {
                        if (sendersLength) {
                            this.viewers[id].senders.find(sender => sender.track.kind === track.kind).replaceTrack(track);
                        }
                        else {
                            this.viewers[id].senders.push(this.viewers[id].peerConnection.addTrack(track, this.sharingStream.display));
                        }
                    });
                }
            });
            this.socket.emit("presenterStartSharing");
        }

        this.onStatusChanged();
        return true;
    }

    async stopSharing(stopEvent) {
        Object.keys(this.viewers).forEach(id => {
            this.viewers[id].sharedStream = false;
        });

        if (!this.sharingStream.display) {
            return;
        }
        let tracks = this.getTracks();
        tracks.forEach(track => {
            track.enabled = false;
            track.stop();
        });
        this.sharingStream.display = null;
        if (stopEvent) {
            stopEvent.call();
        }
        this.stop();
        this.socket.emit("presenterStopSharing");
        this.onStatusChanged();
    }

    getTracks() {
        if (!this.sharingStream.display) {
            return [];
        }
        let tracks = [];
        if (!this.sharingStream.audio) {
            tracks = this.sharingStream.display.getTracks();
        }
        else {
            tracks = new MediaStream([this.sharingStream.audio.getTracks()[0], this.sharingStream.display.getTracks()[0]]).getTracks();
        }
        if (this.sharingOptions.microphone == "muted") {
            tracks.forEach(track => {
                if (track.kind == "audio") {
                    track.enabled = false;
                }
            });
        }
        return tracks;
    }

    setOptions(options = {}) {
        let tracks = this.getTracks();
        tracks.forEach(track => {
            if (track.kind == "audio") {
                track.enabled = options.microphone != "muted";
            }
        });
    }

    createPeerConnection(viewer) {
        if (this.sharingOptions.mechanism == 'streamserver') {
            return;
        }
        if (!this.iceServers) {
            this.iceServers = [
                { urls: "stun:stun.l.google.com:19302" },
            ]
        }
        const pc = new RTCPeerConnection({
            sdpSemantics: "unified-plan",
            iceServers: this.iceServers
        });

        pc.onnegotiationneeded = async () => {
            //this.setCodecPreferences(pc, ['H264']);
            const offer = await viewer.peerConnection.createOffer();
            await viewer.peerConnection.setLocalDescription(offer);
            this.socket.emit("setPresenterOffer", { id: viewer.id, offer: offer });
        };

        pc.onicecandidate = (iceEvent) => {
            if (iceEvent && iceEvent.candidate) {
                this.socket.emit("setPresenterCandidate", { id: viewer.id, candidate: iceEvent.candidate });
            }
        };

        viewer.sharedStream = false;
        viewer.senders = [];
        if (this.sharingStream.display) {
            viewer.sharedStream = true;
            let tracks = this.getTracks();
            tracks.forEach(track => {
                viewer.senders.push(pc.addTrack(track, this.sharingStream.display));
            });
        }

        viewer.peerConnection = pc;
    }

    async setCodecPreferences(pc, codecs) {
        const capabilityCodecs = RTCRtpSender.getCapabilities('video').codecs;
        let preferredCodecs = [];
        let otherCodecs = [];
        for (let i = 0; i < capabilityCodecs.length; i++) {
            const mimeType = capabilityCodecs[i].mimeType;
            let isPreferred = false;
            //    (mimeType == 'video/ulpfec' || mimeType == 'video/red' ||
            //     mimeType == 'video/rtx');
            for (let j = 0; j < codecs.length; j++) {
                if (mimeType.includes(codecs[j])) {
                    isPreferred = true;
                    break;
                }
            }
            if (isPreferred) {
                preferredCodecs.push(capabilityCodecs[i]);
            }
            else {
                otherCodecs.push(capabilityCodecs[i]);
            }
        }
        let finalCodecs = [...preferredCodecs, ...otherCodecs];
        const transceivers = pc.getTransceivers();
        transceivers.forEach(transceiver => {
            if (transceiver.sender.track.kind == 'video') {
                transceiver.setCodecPreferences(finalCodecs);
            }
        });
    }

    setMechanism(mechanism) {
        this.socket.emit("setMechanism", mechanism);
    }

    onStatusChanged() {
    }

    presenterResponse(message) {
        if (message.response != 'accepted') {
            var errorMsg = message.message ? message.message : 'Unknow error';
            console.warn('Call not accepted for the following reason: ' + errorMsg);
            this.dispose();
        }
        else {
            this.webRtcPeer.processAnswer(message.sdpAnswer);
        }
    }

    presenter() {
        if (!this.webRtcPeer) {
            if (!this.iceServers) {
                this.iceServers = [
                    { urls: "stun:stun1.l.google.com:1930" }
                ]
            }
            var options = {
                videoStream: this.sharingStream.display,
                audioStream: this.sharingStream.audio,
                onicecandidate: this.onIceCandidate.bind(this),
                configuration: {
                    iceServers: this.iceServers
                }
            }
            let _this = this;
            this.webRtcPeer = kurentoUtils.WebRtcPeer.WebRtcPeerSendonly(options, function (error) {
                if (error) return _this.onError(error);

                this.generateOffer(_this.onOfferPresenter.bind(_this));
            });
        }
    }

    onOfferPresenter(error, offerSdp) {
        if (error) return this.onError(error);

        var message = {
            id: 'presenter',
            sdpOffer: offerSdp
        };
        this.sendMessage(message);
    }

    onIceCandidate(candidate) {
        var message = {
            id: 'onIceCandidate',
            candidate: candidate
        }
        this.sendMessage(message);
    }

    stop() {
        if (this.webRtcPeer) {
            var message = {
                id: 'stop'
            }
            this.sendMessage(message);
            this.dispose();
        }
    }

    dispose() {
        if (this.webRtcPeer) {
            this.webRtcPeer.dispose();
            this.webRtcPeer = null;
        }
    }

    sendMessage(message) {
        var jsonMessage = JSON.stringify(message);
        this.socket.send(jsonMessage);
    }
};