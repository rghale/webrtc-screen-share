# WebRTC Based Screen Sharing

WebRTC screen sharing project. It supports Chrome, Firefox, Safari, Opera, Android, and Microsoft Edge. Platforms: Linux, Mac and Windows.

----------

## Live Demo

Presenter <https://51.158.104.137:3000/presenter.htm?session_id=123456>

Viewer <https://51.158.104.137:3000/viewer.htm?session_id=123456>

----------

## Installation Steps

### Pre-requirements

Install following apps on your server:

#### Mandatory

* Last version of Node.js <https://nodejs.org/en/>

* Last version of Coturn server (STUN & TRUN server) <https://meetrix.io/blog/webrtc/coturn/installation.html>

    note: You can also use free STUN servers but in many cases, it causes the viewer cannot display streamed data because of routing problems.

#### Optional

* Last version of Kurento media server (to using stream server) <https://doc-kurento.readthedocs.io/en/latest/user/installation.html>

### Installation

1. Clone the repository

    ```bash
    git clone https://github.com/rghale/webrtc-screen-share.git
    ```

2. Install Node modules

    ```bash
    cd webrtc-screen-share 
    npm install
    ```

3. Set your desired port, Kurento server IP and certificates in ./server.js as following:

    ```js
    const httpPort = 3000; //your desired port
    const kurentoIP = '127.0.0.1'; //if using kurento specify IP address here   
    const kurentoPort = 8888; //if using kurento specify port number here   
    ...
    const server = https.createServer({
        key: fs.readFileSync('./certs/key.pem'),
        cert: fs.readFileSync('./certs/cert.pem'),
        passphrase: 'your certificate passphrase'
    }, app);     
    ...
    
    ```

4. Copy user SSL certificates in ./certs as following:

    ```text
    ./cert/cert.pem
    ./cert/key.pem
    ```

5. Set you STUN server in ./public/presenter.htm and ./public/viewer.htm as following:

    ```javascript
    //presenter.htm
    var presenterObj = new presenter({
    iceServers: [
        { urls:"stun:stun_server_pubic_ip:stun_server_port"},
        …
    ]
    });
    ```

    ```javascript
    //viewer.htm
    var viewerObj = new viewer({
    iceServers: [
        { urls:"stun:stun_server_pubic_ip:stun_server_port"},
        …
    ]
    });
    ```

6. Start Node.js server using pm2 as following

    ```bash
    pm2 start server.js 
    ```

7. Now you can browse prenseter.htm & viewer.htm as following:

    ```text
    https://yourdomain:node_port/presenter.htm
    https://yourdomain:node_port/viewer.htm    
    ```

## API reference

### Presenter class

#### *constructor(options)*

```text
options:
    iceServers: list of STUN or TURN servers
    [
        {urls: "stun:stun_server1_pubic_ip: stun_server1_port"},
        {urls: "trun:trun_server2_pubic_ip: stun_server2_port", credential: "your credential", username: "user user name"}
    ]
```

#### *startSharing(options, startEvent, stopEvent, failedEvent)*

```text
start screen sharing
options:
    mechanism: mechanism of sharing
        * distributed
        * peer
        * streamserver
    maxFrameRate: maximum frame rate (number 1 .. 30)
    screenSize: size of shared stream screen (ex: 800*600, 1360*768)
    microphone: audio state
        * muted
        * unmuted
    startEvent: the event that raises when sharing start
    stopEvent: the event that raises when sharing stop
    failedEvent: the event that raises when sharing failed
```

#### *startSharing(stopEvent)*

```text
stop screen sharing
stopEvent: the event that raises when sharing stop
```

#### *setOptions(options)*

```text
set sharing options
options:
    microphone: audio state
        * muted
        * unmuted
```

#### *onStatusChanged*

```text
This is an event, and raises when any status of sharing status is changed
```

#### Public Properties

* isConnected (boolean): node socket connected or not

### Viewer class

#### *constructor(options)*

```text
options:
    player: video play object
    iceServers: list of STUN or TURN servers
    [
        {urls: "stun:stun_server1_pubic_ip: stun_server1_port"},
        {urls: "trun:trun_server2_pubic_ip: stun_server2_port", credential: "your credential", username: "user user name"}
    ]
```

#### *onStatusChanged*

```text
This is an event, and raises when any status of sharing status is changed.
```

#### Public Properties

* played (boolean): playing video status
* isWaitingViewer (boolean): viewer joined to presenter or not
* presenterStatus (string): online or offline
* isSharing (boolean): sharing available or not
* isConnected (boolean): node socket connected or not
