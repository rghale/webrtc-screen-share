const httpPort = 3000;
const kurentoIP = '127.0.0.1';
const kurentoPort = 8888;
const fs = require('fs');
const https = require('https');
const express = require('express');
const kurento = require('kurento-client');
const app = express();

const server = https.createServer({
	key: fs.readFileSync('./certs/key.pem'),
	cert: fs.readFileSync('./certs/cert.pem'),
	passphrase: 'your certificate passphrase'
}, app);

const sio = require('socket.io')({
	cors: {
		origin: "*",
		methods: ["GET", "POST"]
	}
});

sio.attach(server);

server.listen(httpPort, () => {
	console.log(`Http server listening at port ${httpPort}`);
});

app.use(function (req, res, next) {
	// Website you wish to allow to connect
	res.setHeader('Access-Control-Allow-Origin', '*');

	// Request methods you wish to allow
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');

	// Request headers you wish to allow
	res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');

	// Set to true if you need the website to include cookies in the requests sent
	// to the API (e.g. in case you use sessions)
	res.setHeader('Access-Control-Allow-Credentials', true);

	// Pass to next layer of middleware
	next();
});


app.use(express.static('public'));

/*
 * Definition of global variables.
 */
var stIdCounter = 0;
var stCandidatesQueue = {};
var stKurentoClient = null;
var stPresenter = {};
var stViewers = [];
var stNoPresenterMessage = 'No active presenter. Try again later...';

var presenter = {};
var viewers = {};
var waitingViewers = {};

const stOptions = {
	ws_uri: 'ws://' + kurentoIP + ':' + kurentoPort + '/kurento'
};

const getSender = (sessionId, id) => {
	if (!presenter || !presenter[sessionId]) {
		return;
	}
	if (presenter[sessionId].streamMechanism == "peer") {
		return presenter[sessionId].id;
	}
	let viewerKeys = Object.keys(viewers);
	if (Object.keys(presenter[sessionId].viewers).length < 2) {
		return presenter[sessionId].id;
	}
	let senderId = null;
	for (let idx = 0; idx < viewerKeys.length; idx++) {
		let viewer = viewers[viewerKeys[idx]];
		if (!viewer) {
			continue;
		}
		if (viewer.sessionId != sessionId) {
			continue;
		}
		if (viewer.disconnected) {
			viewer.disconnect();
			continue;
		}
		if (viewer.isMobile == 'true') {
			continue;
		}
		if (Object.keys(viewer.viewers).length >= 2) {
			continue;
		}
		if (viewer.parents[id]) {
			continue;
		}
		if (viewer.senderId == viewers[id].senderId) {
			continue;
		}
		senderId = viewer.id;
		break;
	}
	if (!senderId) {
		senderId = presenter[sessionId].id;
	}
	return senderId;
};

const unregisterViewer = (socket) => {
	Object.keys(socket.parents).forEach(parent => {
		if (viewers[parent]) {
			delete viewers[parent].childs[socket.id];
		}
	});
	if (presenter && presenter[socket.sessionId] && presenter[socket.sessionId].parents[socket.id]) {
		delete presenter[socket.sessionId].parents[socket.id];
	}

	Object.keys(socket.childs).forEach(child => {
		if (viewers[child]) {
			delete viewers[child].parents[socket.id];
		}
	});
	if (presenter && presenter[socket.sessionId] && presenter[socket.sessionId].childs[socket.id]) {
		delete presenter[socket.sessionId].childs[socket.id];
	}

	if (presenter && presenter[socket.sessionId]) {
		delete presenter[socket.sessionId].viewers[socket.id];
	}
	delete viewers[socket.id];

	if (socket.viewers) {
		Object.keys(socket.viewers).forEach(viewer => {
			try {
				if (!viewers[viewer]) {
					return;
				}
				viewers[viewer].senderId = getSender(viewers[viewer].sessionId, viewers[viewer].id);
				viewers[viewer].emit("senderDisconnected", { newSenderId: viewers[viewer].senderId });
				let sender = viewers[viewer].senderId != presenter[socket.sessionId].id ? viewers[viewers[viewer].senderId] : presenter[socket.sessionId];
				sender.viewers[viewer] = viewers[viewer];
				if (presenter && presenter[socket.sessionId]) {
					presenter[socket.sessionId].emit("viewerRegistered", { id: viewer, sender: viewers[viewer].senderId });
				}
			}
			catch (ex) { }
		});
	}
	if (viewers[socket.senderId]) {
		delete viewers[socket.senderId].viewers[socket.id];
		if (!viewers[socket.senderId].viewers) {
			viewers[socket.senderId].viewers = {};
		}
	}

	console.log("unregister viewer " + socket.id);

	if (presenter && presenter[socket.sessionId]) {
		presenter[socket.sessionId].emit("viewerLeave", { id: socket.id });
	}
}

function nextUniqueId() {
	stIdCounter++;
	return stIdCounter.toString();
}

sio.on('connection', (socket) => {
	socket.isMobile = socket.handshake.query.mobile;
	socket.sessionId = socket.handshake.query.session_id ? socket.handshake.query.session_id : 'general';
	socket.on('registerPresenter', (fn) => {
		if (presenter[socket.sessionId]) {
			if (typeof (fn) == 'function') {
				fn(false);
			}
			return;
		}
		console.log("register presenter " + socket.sessionId + " " + socket.id);
		presenter[socket.sessionId] = socket;
		presenter[socket.sessionId].viewers = {};
		presenter[socket.sessionId].parents = {};
		presenter[socket.sessionId].childs = {};
		presenter[socket.sessionId].maxConnection = 2;
		presenter[socket.sessionId].streamMechanism = "distributed";
		socket.isPresenter = true;

		let existingViewers = [];
		Object.keys(viewers).forEach(id => {
			if (viewers[id].sessionId == socket.sessionId) {
				viewers[id].emit("presenterAvailable");
				existingViewers.push({ id: id });
			}
		});
		Object.keys(waitingViewers).forEach(id => {
			if (waitingViewers[id].sessionId == socket.sessionId) {
				waitingViewers[id].emit("presenterAvailable");
			}
		});
		//socket.emit("sendExistingViewers", existingViewers);		
		if (typeof (fn) == 'function') {
			fn(true);
		}
	});

	socket.on('registerWaitingViewer', (fn) => {
		console.log("register waiting viewer " + socket.sessionId + " " + socket.id);
		if (viewers[socket.id]) {
			unregisterViewer(socket);
		}

		waitingViewers[socket.id] = socket;
		if (typeof (fn) == 'function') {
			fn({ presenterStatus: presenter && presenter[socket.sessionId] ? 'online' : 'offline', sharingStatus: presenter && presenter[socket.sessionId] ? presenter[socket.sessionId].sharingStatus : 'stop' });
		}
	});

	socket.on('registerViewer', (fn) => {
		console.log("register viewer " + socket.sessionId + " " + socket.id);
		delete waitingViewers[socket.id];
		viewers[socket.id] = socket;
		socket.isViewer = true;
		socket.viewers = {};
		socket.parents = {};
		socket.childs = {};
		if (!presenter || !presenter[socket.sessionId]) {
			socket.waitingPresenter = true;
			return;
		}
		socket.senderId = getSender(socket.sessionId, socket.id);

		let sender = viewers[socket.senderId] ? viewers[socket.senderId] : presenter[socket.sessionId];
		sender.viewers[socket.id] = socket;

		sender.childs[socket.id] = true;
		Object.keys(sender.parents).forEach(parent => {
			if (viewers[parent]) {
				viewers[parent].childs[socket.id] = true;
			}
		})
		socket.parents[sender.id] = true;

		if (presenter && presenter[socket.sessionId]) {
			presenter[socket.sessionId].emit("viewerRegistered", { id: socket.id, sender: socket.senderId });
		}
		if (typeof (fn) == 'function') {
			fn({ senderId: socket.senderId, sharingStatus: presenter[socket.sessionId].sharingStatus, streamMechanism: presenter && presenter[socket.sessionId] ? presenter[socket.sessionId].streamMechanism : null });
		}
	});

	socket.on('disconnect', () => {
		stop(sessionId, socket);
		if (socket.isPresenter) {
			console.log("unregister presenter " + socket.sessionId + " " + socket.id);
			delete presenter[socket.sessionId];
			Object.keys(viewers).forEach(id => {
				if (viewers[id].sessionId == socket.sessionId) {
					viewers[id].emit("presenterUnavailable");
				}
			});
			Object.keys(waitingViewers).forEach(id => {
				if (waitingViewers[id].sessionId == socket.sessionId) {
					waitingViewers[id].emit("presenterUnavailable");
				}
			});
			Object.keys(socket.viewers).forEach(id => {
				socket.viewers[id].emit("senderDisconnected");
			});
		}
		if (socket.isViewer) {
			unregisterViewer(socket);
		}
	});

	socket.on("setPresenterOffer", (data) => {
		if (!viewers[data.id]) {
			return;
		}
		viewers[data.id].emit("sendPresenterOffer", { offer: data.offer });
	})

	socket.on("setViewerOffer", (data) => {
		if (socket.senderId && viewers[socket.senderId]) {
			viewers[socket.senderId].emit("sendViewerOffer", { id: socket.id, offer: data.offer });
		}
		else {
			presenter && presenter[socket.sessionId] && presenter[socket.sessionId].emit("sendViewerOffer", { id: socket.id, offer: data.offer });
		}
	});

	socket.on("setPresenterCandidate", (data) => {
		if (!viewers[data.id]) {
			return;
		}
		viewers[data.id].emit("sendPresenterCandidate", { candidate: data.candidate });
	});

	socket.on("setViewerCandidate", (data) => {
		if (!presenter || !presenter[socket.sessionId]) {
			return;
		}
		if (data.id) {
			if (viewers[data.id]) {
				viewers[data.id].emit("sendPresenterCandidate", { candidate: data.candidate });
			}
		}
		else {
			if (socket.senderId != presenter[socket.sessionId].id) {
				if (viewers[socket.senderId]) {
					viewers[socket.senderId].emit("sendViewerCandidate", { id: socket.id, candidate: data.candidate });
				}
			}
			else {
				presenter[socket.sessionId].emit("sendViewerCandidate", { id: socket.id, candidate: data.candidate });
			}
		}
	});

	socket.on("senderCreatePeerConnection", (data) => {
		if (!viewers[data.sender]) {
			return;
		}
		viewers[data.sender].emit("senderCreatePeerConnection", { id: data.viewer });
	});

	socket.on("presenterStopSharing", (data) => {
		if (!presenter[socket.sessionId]) {
			return;
		}
		presenter[socket.sessionId].sharingStatus = "stop";
		Object.keys(viewers).forEach(id => {
			if (viewers[id].sessionId == socket.sessionId) {
				viewers[id].emit("sharingStopped");
			}
		});
		Object.keys(waitingViewers).forEach(id => {
			if (waitingViewers[id].sessionId == socket.sessionId) {
				waitingViewers[id].emit("sharingStopped");
			}
		});
		stop(socket.sessionId, socket);
	});

	socket.on("presenterStartSharing", (data) => {
		if (presenter[socket.sessionId]) {
			presenter[socket.sessionId].sharingStatus = "start";
		}
		Object.keys(viewers).forEach(id => {
			if (viewers[id].sessionId == socket.sessionId) {
				viewers[id].emit("sharingStarted");
			}
		});
		Object.keys(waitingViewers).forEach(id => {
			if (waitingViewers[id].sessionId == socket.sessionId) {
				waitingViewers[id].emit("sharingStarted");
			}
		});
		for (let id in socket.viewers) {
			socket.viewers[id].emit("senderStartPlaying");
		}
	});

	socket.on("setMechanism", (data) => {
		if (!socket.isPresenter) {
			return;
		}
		socket.streamMechanism = data;
	});

	socket.on("checkValidViewer", (id) => {
		socket.emit("checkValidViewerResponse", { id: id, isValid: viewers[id] != null, sender: viewers[id] != null ? viewers[id].senderId : null });
	});

	/* strem server */
	var sessionId = nextUniqueId();
	//var sessionId = socket.sessionId;
	console.log('Connection received with sessionId ' + sessionId);

	socket.on('error', function (error) {
		console.log('Connection ' + sessionId + ' error');
		stop(sessionId, socket);
	});

	socket.on('close', function () {
		console.log('Connection ' + sessionId + ' closed');
		stop(sessionId, socket);
	});

	socket.on('message', function (_message) {
		var message = JSON.parse(_message);
		switch (message.id) {
			case 'presenter':
				startPresenter(sessionId, socket, message.sdpOffer, function (error, sdpAnswer) {
					if (error) {
						return socket.send(JSON.stringify({
							id: 'presenterResponse',
							response: 'rejected',
							message: error
						}));
					}
					socket.send(JSON.stringify({
						id: 'presenterResponse',
						response: 'accepted',
						sdpAnswer: sdpAnswer
					}));
				});
				break;

			case 'viewer':
				startViewer(sessionId, socket, message.sdpOffer, function (error, sdpAnswer) {
					if (error) {
						return socket.send(JSON.stringify({
							id: 'viewerResponse',
							response: 'rejected',
							message: error
						}));
					}

					socket.send(JSON.stringify({
						id: 'viewerResponse',
						response: 'accepted',
						sdpAnswer: sdpAnswer
					}));
				});
				break;

			case 'stop':
				stop(sessionId, socket);
				break;

			case 'onIceCandidate':
				onIceCandidate(sessionId, message.candidate, socket);
				break;

			default:
				socket.send(JSON.stringify({
					id: 'error',
					message: 'Invalid message ' + message
				}));
				break;
		}
	});
});

/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getstKurentoClient(socket, callback) {
	if (stKurentoClient !== null) {
		return callback(null, stKurentoClient);
	}

	kurento(stOptions.ws_uri, function (error, _stKurentoClient) {
		if (error) {
			console.log("Could not find media server at address " + stOptions.ws_uri);
			return callback("Could not find media server at address" + stOptions.ws_uri
				+ ". Exiting with error " + error);
		}
		console.log("Open kurento clinet");
		stKurentoClient = _stKurentoClient;
		callback(null, stKurentoClient);
	});
}

function startPresenter(sessionId, socket, sdpOffer, callback) {
	clearCandidatesQueue(sessionId);

	if (stPresenter[socket.sessionId] !== null && stPresenter[socket.sessionId] !== undefined) {
		stop(sessionId, socket);
		return callback("Another user is currently acting as stPresenter. Try again later ...");
	}

	stPresenter[socket.sessionId] = {
		id: sessionId,
		pipeline: null,
		webRtcEndpoint: null
	}
	socket.webRtcEndpoint = null;

	getstKurentoClient(socket, function (error, stKurentoClient) {
		if (error) {
			stop(sessionId, socket);
			return callback(error);
		}

		if (stPresenter[socket.sessionId] === null || stPresenter[socket.sessionId] === undefined) {
			stop(sessionId, socket);
			return callback(stNoPresenterMessage);
		}
		stKurentoClient.create('MediaPipeline', function (error, pipeline) {
			if (error) {
				stop(sessionId, socket);
				return callback(error);
			}

			if (!stPresenter[socket.sessionId]) {
				stop(sessionId, socket);
				return callback(stNoPresenterMessage);
			}

			stPresenter[socket.sessionId].pipeline = pipeline;

			socket.emit("streamserverPresenterAvailable");

			pipeline.create('WebRtcEndpoint', function (error, webRtcEndpoint) {
				if (error) {
					stop(sessionId, socket);
					return callback(error);
				}

				if (!stPresenter[socket.sessionId]) {
					stop(sessionId, socket);
					return callback(stNoPresenterMessage);
				}

				stPresenter[socket.sessionId].webRtcEndpoint = webRtcEndpoint;
				socket.webRtcEndpoint = webRtcEndpoint;

				if (stCandidatesQueue[sessionId]) {
					while (stCandidatesQueue[sessionId].length) {
						var candidate = stCandidatesQueue[sessionId].shift();
						webRtcEndpoint.addIceCandidate(candidate);
					}
				}

				webRtcEndpoint.on('OnIceCandidate', function (event) {
					var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
					socket.send(JSON.stringify({
						id: 'iceCandidate',
						candidate: candidate
					}));
				});

				webRtcEndpoint.processOffer(sdpOffer, function (error, sdpAnswer) {
					if (error) {
						stop(sessionId, socket);
						return callback(error);
					}

					if (!stPresenter[socket.sessionId]) {
						stop(sessionId, socket);
						return callback(stNoPresenterMessage);
					}

					callback(null, sdpAnswer);
				});

				webRtcEndpoint.gatherCandidates(function (error) {
					if (error) {
						stop(sessionId, socket);
						return callback(error);
					}
				});
			});
		});
	});
}

function startViewer(sessionId, socket, sdpOffer, callback) {
	if (!stPresenter[socket.sessionId]) {
		stop(sessionId, socket);
		return callback(stNoPresenterMessage);
	}
	stPresenter[socket.sessionId].pipeline.create('WebRtcEndpoint', function (error, webRtcEndpoint) {
		if (error) {
			stop(sessionId, socket);
			return callback(error);
		}
		if (!viewers[socket.id]) {
			stop(sessionId, socket);
			return;
		}
		viewers[socket.id].webRtcEndpoint = webRtcEndpoint;
		/*stViewers[sessionId] = {
			"webRtcEndpoint" : webRtcEndpoint,
			"ws" : socket
		}*/

		if (!stPresenter[socket.sessionId]) {
			stop(sessionId, socket);
			return callback(stNoPresenterMessage);
		}

		if (stCandidatesQueue[sessionId]) {
			while (stCandidatesQueue[sessionId].length) {
				var candidate = stCandidatesQueue[sessionId].shift();
				webRtcEndpoint.addIceCandidate(candidate);
			}
		}

		webRtcEndpoint.on('OnIceCandidate', function (event) {
			var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
			socket.send(JSON.stringify({
				id: 'iceCandidate',
				candidate: candidate
			}));
		});

		webRtcEndpoint.processOffer(sdpOffer, function (error, sdpAnswer) {
			if (error) {
				stop(sessionId, socket);
				return callback(error);
			}
			if (!stPresenter[socket.sessionId]) {
				stop(sessionId, socket);
				return callback(stNoPresenterMessage);
			}

			stPresenter[socket.sessionId].webRtcEndpoint.connect(webRtcEndpoint, function (error) {
				if (error) {
					stop(sessionId, socket);
					return callback(error);
				}
				if (!stPresenter[socket.sessionId]) {
					stop(sessionId, socket);
					return callback(stNoPresenterMessage);
				}

				callback(null, sdpAnswer);
				webRtcEndpoint.gatherCandidates(function (error) {
					if (error) {
						stop(sessionId, socket);
						return callback(error);
					}
				});
			});
		});
	});
}

function clearCandidatesQueue(sessionId) {
	if (stCandidatesQueue[sessionId]) {
		delete stCandidatesQueue[sessionId];
	}
}

function stop(sessionId, socket) {
	if (socket.isPresenter) {
		Object.keys(viewers).forEach(id => {
			if (viewers[id] && viewers[id].sessionId == socket.sessionId) {
				viewers[id].send(JSON.stringify({
					id: 'stopCommunication'
				}));
				if (viewers[id].webRtcEndpoint) {
					viewers[id].webRtcEndpoint.release();
					viewers[id].webRtcEndpoint = null;
				}
			}
		});
		if (stPresenter[socket.sessionId] && stPresenter[socket.sessionId].pipeline) {
			stPresenter[socket.sessionId].pipeline.release();
			stPresenter[socket.sessionId].pipeline = null;
		}
		delete stPresenter[socket.sessionId];
	}
	else if (/*stViewers[sessionId]*/ viewers[socket.id]) {
		//stViewers[sessionId].webRtcEndpoint.release();
		if (viewers[socket.id] && viewers[socket.id].webRtcEndpoint) {
			viewers[socket.id].webRtcEndpoint.release();
			viewers[socket.id].webRtcEndpoint = null;
		}
		//delete stViewers[sessionId];
	}

	clearCandidatesQueue(sessionId);

	/*if (socket.isPresenter) {
		if (stKurentoClient[socket.sessionId]) {
			console.log('Closing kurento client');
			stKurentoClient[socket.sessionId].close();
			delete stKurentoClient[socket.sessionId];			
		}
	}*/
}

function onIceCandidate(sessionId, _candidate, socket) {
	var candidate = kurento.getComplexType('IceCandidate')(_candidate);

	if (socket.isPresenter && socket.webRtcEndpoint /* stPresenter[sessionId] && stPresenter[sessionId].id === sessionId && stPresenter[sessionId].webRtcEndpoint*/) {
		//stPresenter[sessionId].webRtcEndpoint.addIceCandidate(candidate);
		socket.webRtcEndpoint.addIceCandidate(candidate);
	}
	else if (socket.isViewer && socket.webRtcEndpoint) {
		//stViewers[sessionId].webRtcEndpoint.addIceCandidate(candidate);
		socket.webRtcEndpoint.addIceCandidate(candidate);
	}
	else {
		if (!stCandidatesQueue[sessionId]) {
			stCandidatesQueue[sessionId] = [];
		}
		stCandidatesQueue[sessionId].push(candidate);
	}
}