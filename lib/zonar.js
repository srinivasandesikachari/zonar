var ipAddresses = require('./ipaddresses');
var merge = require('merge');
var dgram = require('dgram');
var fs = require('fs');
var Netmask = require('netmask').Netmask;
var events = require('events');
var path = require('path');
var packageInfo = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8')); 

var defaultOptions = {
    net: "zon", 
    broadcastAddress: null,
    scanPort: 5666,
    autoScan: true,
    broadcastIdentifier: "ZONAR",
    payload: "",
    pulseTimer: 1000 * 60 * 5
};

function Zonar(options) {

    // Check fi the options we got are ok
    checkOptions(options);

    var listenSocket = null;
    var socket = null;
    var status = "inactive";
    var self = this;

    events.EventEmitter.call(this);

    // Merge default and custom options
    options = merge(defaultOptions, options);

    var nodeList = {};
    var id = this.id = randomString(64);
    var broadcastIdentifier = options.broadcastIdentifier;
    var name = options.name.replace(/[\s]/g, '-').toLowerCase();
    var scanPort = options.scanPort;
    var netId = options.net;

    var addressList = ipAddresses.get();
    var address = addressList[addressList.length - 1];
    var broadcastAddress = options.broadcastAddress;
    var payload = options.payload;
    var payloadLength = (new Buffer(payload)).length;
    var pulseTimer = options.pulseTimer;
    var keepAliveTimer = pulseTimer * 1.1;
    var pulseIntervalRef = -1;

    if (!broadcastAddress) {
        var block = new Netmask(address + "/24");
        broadcastAddress = block.broadcast;
    }

    // Begin transmitting
    function start(next) {
        if (status == "inactive") {
            status = "starting";
            listen(function(err) {
                broadcast(function() {
                    status = "broadcasting";
                    if (typeof next == "function") {
                        next();
                    }
                });
            });
        }
        else {
            if (typeof next == "function") {
                next();
            }
        }

    }

    function stop(next) {

        var message = createMessage("QUIT");
        send(message, scanPort, broadcastAddress, function() {


            clearInterval(pulseIntervalRef);

            listenSocket.close();
            socket.close();
            status = "inactive";

            if (typeof next == "function") {
                next();
            }

        });

    }

    // Listen for incoming single messages
    function listen(next) {

        listenSocket = dgram.createSocket('udp4');

        listenSocket.on('message', function(payload, rinfo) {
            var message = parseMessage(payload, rinfo);
            if (message) {
                if (message.id != id) {
                    if (message.status == "ONE") {
                        updateNodeList(message);
                    }
                }
            }
        });

        listenSocket.bind(function() {
            var info = listenSocket.address();
            self.port = info.port;
            next();
        });

    }

    // Send my info to listeners
    function sendMyInfo(senderMessage, senderInfo) {

        var message = createMessage("ONE");
        var socket = dgram.createSocket('udp4');

        socket.bind(function() {
            socket.send(message, 0, message.length, senderMessage.port, senderInfo.address, function(err, bytes) {
                socket.close();
            });
        });

    }

    function updateNodeList(message) {

        var nodeKey = getNodeKey(message);

        if (message.status == "QUIT") {

            if (nodeList[nodeKey]) {
                delete nodeList[nodeKey];
                self.emit('dropped', message);
            }

        } else {

            //console.log("%s < %s", name, message.name);
            if (!nodeList[nodeKey]) {

                delete message.status;
                nodeList[nodeKey] = message;

                var newArrayList = [];
                for(var key in nodeList) {
                    newArrayList.push({
                        key: key,
                        node: nodeList[key]
                    });
                }

                newArrayList.sort(function(a, b){
                    if (a.key < b.key) return -1;
                    if (a.key > b.key) return 1;
                    return 0;
                });

                var list = {};
                newArrayList.forEach(function(item) {
                    var key = item.key;
                    delete item.key;
                    var node = item.node;
                    list[key] = item.node;
                });

                nodeList = list;
                var c = 0;
                for(k in nodeList) {
                    c++;
                }

                self.emit('found', message);

            }

            nodeList[nodeKey].timestamp = (new Date()).getTime();

        }

    }


    function getNodeKey(nodeInfo) {
        //var nodeKey = nodeInfo.id + "-" + nodeInfo.address + ":" + nodeInfo.port;
        return nodeInfo.name;
    }


    function send(message, port, address, next) {
        socket.send(message, 0, message.length, port, address, function(err, bytes) {
            if (typeof next == "function") {
                next();
            }
            //console.log("%s sent '%s' = %s bytes to %s:%s", name, message, bytes, address, port);
        });
    }



    function broadcast(next) {


        //time = (new Date()).getTime();
        var message = createMessage("NEW");

        socket = dgram.createSocket('udp4');

        socket.on('message', function(payload, rinfo) {

            var message = parseMessage(payload, rinfo);

            if (message) {

                if (message.id != id) {
                    //console.log("%s got %s", name, payload.toString());
                    if (message.status == "NEW") {
                        sendMyInfo(message, rinfo);
                    }
                    updateNodeList(message);
                }

            }

        });

        socket.bind(scanPort, function() {

            socket.setBroadcast(true);

            function pulse() {
                send(message, scanPort, broadcastAddress);
                message = createMessage("ALIVE");
                keepAliveCheck();
            }

            pulse();

            pulseIntervalRef = setInterval(pulse, pulseTimer);

            if (typeof next == "function") {
                next();
            }


        });


    }

    function getList() {
        return nodeList;
    }

    function keepAliveCheck() {

        var newList = {};

        for(var key in nodeList) {

            var node = nodeList[key];
            var timestamp = node.timestamp;
            var now = (new Date()).getTime();
            var delta = now - timestamp;
            if (delta < keepAliveTimer) {
                newList[key] = node;
            } else {
                self.emit('lost', node);
            }

        }

        nodeList = newList;

    }

    function parseMessage(payload, senderInfo) {

        var messageString = payload.toString();

        var messageParts = messageString.split(" ");

        var messageObject = null;

        var messageIdentifier = messageParts.shift();
        var version = messageParts.shift(); 

        if (messageParts.length > 0 && messageIdentifier == broadcastIdentifier && version == packageInfo.version) {

            messageObject = {
                net: messageParts.shift(),
                id: messageParts.shift(),
                name: messageParts.shift(),
                port: messageParts.shift(),
                status: messageParts.shift(),
            };

            // pick out the last strings as pairs of length:message
            var customMessagesString = messageParts.join(" ");
            var cursor = 0;
            var customMessages = [];

            while (customMessagesString.length != 0) {

                var indexOfSeparator = customMessagesString.indexOf(":");
                var length = parseInt(customMessagesString.substring(cursor, indexOfSeparator));
                customMessagesString = customMessagesString.substring(indexOfSeparator + 1);
                var messageString = customMessagesString.substring(0, length);
                customMessagesString = customMessagesString.substring(messageString.length);
                customMessages.push(messageString);
            }

            messageObject.payload = customMessages[0];
            messageObject.address = senderInfo.address;

        }

        return messageObject;

    }

    // Creates the broadcast string, and returns a buffer
    function createMessage(status) {

        var message = [];

        message.push(broadcastIdentifier);
        message.push(packageInfo.version);
        message.push(netId);
        message.push(id);
        message.push(name);
        message.push(self.port);
        message.push(status);
        message.push(payloadLength + ':' + payload);

        var messageString = message.join(" ");

        return new Buffer(messageString);

    }

    function checkOptions(newOpions) {
        if (!newOpions.name) {
            throw new Error("Please provide a name for your service. No spaces.");
        }
    }

    // randomString returns a pseude-random ASCII string which contains at least the specified number of bits of entropy
    // the return value is a string of length ⌈bits/6⌉ of characters from the base64 alphabet
    function randomString(bits) {

        var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        var ret = '';

        // in v8, Math.random() yields 32 pseudo-random bits (in spidermonkey it gives 53)
        while(bits > 0) {
            var rand = Math.floor(Math.random()*0x100000000); // 32-bit integer

            // base 64 means 6 bits per character, so we use the top 30 bits from rand to give 30/6=5 characters.
            for(var i=26; i>0 && bits>0; i-=6, bits-=6) ret+=chars[0x3F & rand >>> i];
        }
        return ret;
    }

    // We just expose the start and getList methods, everything else is considered private
    this.start = start;
    this.stop = stop;
    this.getList = getList;

    // Only for testing purposes, dont use directly
    this._private = {
        createMessage: createMessage,
        parseMessage: parseMessage
    };


}

Zonar.prototype.__proto__ = events.EventEmitter.prototype;

exports.create = function(options) {
    return new Zonar(options);
}
