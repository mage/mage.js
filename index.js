var EventEmitter = require('emitter');
var inherits = require('inherit');
var EventManager = require('mage-event-manager.js');
var HttpServer = require('mage-http-server.js');
var MsgServer = require('mage-message-server.js');
var loader = require('mage-loader.js');


function Mage() {
	EventEmitter.call(this);

	this.eventManager = new EventManager();
	this.msgServer = new MsgServer(this.eventManager);
	this.httpServer = new HttpServer(this.eventManager);

	if (window.mageConfig) {
		this.configure(window.mageConfig);
	}

	var that = this;

	loader.on('density', function (density) {
		that.emit('densityChanged', density);
		that.density = density;
	});

	loader.on('language', function (language) {
		that.emit('languageChanged', language);
		that.language = language;
	});

	return this;
}

inherits(Mage, EventEmitter);


Mage.prototype.getClientHostBaseUrl = function () {
	return this.clientHostBaseUrl;
};


Mage.prototype.getSavvyBaseUrl = function (protocol) {
	var baseUrl = this.savvyBaseUrl;
	if (!baseUrl) {
		baseUrl = '/savvy';
	}

	if (baseUrl[0] === '/') {
		// location.origin is perfect for this, but badly supported

		baseUrl = this.savvyBaseUrl = window.location.protocol + '//' + window.location.host + baseUrl;

		console.warn('No savvy base URL configured, defaulting to:', baseUrl, '(which may not work)');
	}

	if (protocol) {
		// drop any trailing colons and slashes

		protocol = protocol.replace(/:?\/*$/, '');

		return baseUrl.replace(/^.*:\/\//, protocol + '://');
	}

	return baseUrl;
};


Mage.prototype.densities = function () {
	return loader.densities;
};


Mage.prototype.getDensity = function () {
	return loader.clientConfig.density;
};


Mage.prototype.setDensity = function (value) {
	loader.setDensity(value);
};


Mage.prototype.getLanguage = function () {
	return loader.clientConfig.language;
};


Mage.prototype.setLanguage = function (value) {
	loader.setLanguage(value);
};


Mage.prototype.getClientConfig = function () {
	return loader.clientConfig;
};


// expose configuration set up
// mage.configure registers the configuration and emits 'configure'

Mage.prototype.configure = function (config) {
	if (!config) {
		throw new Error('Mage requires a config to be instantiated.');
	}

	var that = this;

	this.config = config;

	this.appName = config.appName;
	this.appConfig = config.appConfig || {};
	this.appVersion = config.appVersion;
	this.appVariants = config.appVariants;
	this.clientHostBaseUrl = config.clientHostBaseUrl;
	this.savvyBaseUrl = config.savvyBaseUrl;
	this.language = loader.clientConfig.language;
	this.density = loader.clientConfig.density;

	// set up httpServer

	var httpWithCredentials = config.cors && config.cors.credentials ? true : false;

	this.httpServer.setupCommandSystem({
		url: config.clientHostBaseUrl + '/' + config.appName,
		httpOptions: {
			timeout: config.timeout || 15000,
			withCredentials: httpWithCredentials,
			noCache: true
		}
	});

	// set up msgServer
	// When a session key is available, start the message stream.
	// If the key changes, make the event system aware (by simply calling setupMessageStream again)

	if (!config.msgStreamUrl) {
		return;
	}

	var msgStreamConfig = {
		url: config.msgStreamUrl,
		httpOptions: {
			withCredentials: httpWithCredentials,
			noCache: true
		}
	};

	this.once('created.session', function () {
		that.eventManager.on('session.set', function (path, session) {
			that.msgServer.setupMessageStream(msgStreamConfig, session.key);
			that.msgServer.start();
		});

		that.eventManager.on('session.unset', function () {
			that.msgServer.abort();
		});
	});
};


Mage.prototype.isDevelopmentMode = function () {
	return this.config.developmentMode;
};


// And here comes the module system.

var setupQueue = [];
var modules = {};

function setupModule(mage, modName, cb) {
	var mod = modules[modName];

	if (!mod) {
		return cb();
	}

	if (!mod.hasOwnProperty('setup')) {
		mage.emit('setup.' + modName, mod);
		return cb();
	}

	mod.setup.call(mod, function (error) {
		if (error) {
			return cb(error);
		}

		mage.emit('setup.' + modName, mod);
		return cb();
	});
}


function setupModules(mage, modNames, cb) {
	var done = 0;
	var len = modNames.length;

	var lastError;

	function finalCb() {
		mage.emit('setupComplete');

		if (cb) {
			cb(lastError);
			cb = null;
		}
	}

	function stepCb(error) {
		lastError = error || lastError;
		done++;

		if (done === len) {
			finalCb();
		}
	}

	if (len === 0) {
		return finalCb();
	}

	for (var i = 0; i < len; i++) {
		setupModule(mage, modNames[i], stepCb);
	}
}


function createUserCommand(params, execPath) {
	// function arguments

	var args = params.concat('cb').join(', ');

	// function body

	var body = [];

	body.push('var httpServer = require(\'mage.js\').httpServer;');
	body.push('var params = {');

	for (var i = 0; i < params.length; i += 1) {
		body.push('\t' + params[i] + ': ' + params[i] + (i < params.length - 1 ? ',' : ''));
	}

	body.push('};');
	body.push('httpServer.sendCommand(' + JSON.stringify(execPath) + ', params, cb);\n');

	var functionBody = '\t' + body.join('\n\t');

	// instantiate and return the function

	/*jshint evil:true */
	return new Function(args, functionBody);
}


Mage.prototype.useModules = function () {
	var appRequire = arguments[0];

	if (typeof appRequire !== 'function') {
		throw new TypeError('useModules: the first argument must be require.');
	}

	var userCommands = this.config.userCommands;
	var execPaths = Object.keys(userCommands);

	for (var i = 1; i < arguments.length; i += 1) {
		var name = arguments[i];

		if (modules.hasOwnProperty(name)) {
			continue;
		}

		if (this[name]) {
			throw new Error('Failed to register module "' + name + '". This is a reserved name.');
		}

		// check if this module should exist
		// if not, we provide an empty object for user commands to be registered on

		var hasImplementation = false;

		var resolved = appRequire.resolve(name);
		if (resolved) {
			hasImplementation = !!window.require.resolve(resolved);
		}

		var mod = hasImplementation ? appRequire(name) : {};

		modules[name] = this[name] = mod;

		for (var j = 0; j < execPaths.length; j += 1) {
			var execPath = execPaths[j];
			var uc = userCommands[execPath];

			if (uc.gameModule === name) {
				hasImplementation = true;

				mod[uc.cmdName] = createUserCommand(uc.mod.params || [], execPath);
			}
		}

		if (!hasImplementation) {
			console.warn('Module "' + name + '" has no implementation.');
		}

		this.emit('created.' + name, mod);

		setupQueue.push(name);
	}

	return this;
};


Mage.prototype.setupModules = function (modNames, cb) {
	// remove all given module names from the current setupQueue

	var newSetupQueue = [];	// replacement array for setupQueue
	var toSetup = [];	// the modNames that we'll end up setting up

	for (var i = 0; i < setupQueue.length; i += 1) {
		var queuedModName = setupQueue[i];

		if (modNames.indexOf(queuedModName) === -1) {
			newSetupQueue.push(queuedModName);
		} else {
			toSetup.push(queuedModName);
		}
	}

	setupQueue = newSetupQueue;

	setupModules(this, toSetup, cb);
};

// expose the setup method, to be called after configure()
// mage.setup sets up all modules yet to be set up,
// after which it emits the event 'setup'

Mage.prototype.setup = function (cb) {
	this.setupModules(setupQueue, cb);
};


module.exports = new Mage();
