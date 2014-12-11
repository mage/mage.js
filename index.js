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

	this.config = config;

	this.appName = config.appName;
	this.appConfig = config.appConfig || {};
	this.appVersion = config.appVersion;
	this.appVariants = config.appVariants;
	this.language = loader.clientConfig.language;
	this.density = loader.clientConfig.density;

	// set up server connections

	this.clientHostBaseUrl = config.baseUrl;
	this.savvyBaseUrl = config.server.savvy.url; // TODO: what about server.savvy.cors?

	this.httpServer.setupCommandSystem(config.server.commandCenter);

	if (this.msgServer.setupMessageStream(config.server.msgStream)) {
		var that = this;

		// When a session key is available, start the message stream.
		// If the key changes, make the event system aware (by simply calling setupMessageStream again)

		this.once('created.session', function () {
			that.eventManager.on('session.set', function (path, session) {
				that.msgServer.setSessionKey(session.key);
				that.msgServer.start();
			});

			that.eventManager.on('session.unset', function () {
				that.msgServer.abort();
			});
		});
	}
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


function createUserCommand(httpServer, modName, cmdName, params) {
	// function name (camelCase)

	var fnName = modName + cmdName[0].toUpperCase() + cmdName.slice(1);

	// function arguments

	params = params.concat('cb');

	var args = params.join(', ');

	// expected use

	var expected = modName + '.' + cmdName + '(' + args + ')';

	// real use

	/*jshint unused:false*/
	function serializeActualUse(args) {
		var result = [];

		for (var i = 0; i < args.length; i += 1) {
			var arg = args[i];

			if (typeof arg === 'function') {
				arg = 'Function';
			} else {
				arg = JSON.stringify(arg);
			}

			result.push(arg);
		}

		return modName + '.' + cmdName + '(' + result.join(', ') + ')';
	}

	// function body

	var body = [];

	body.push('fn = function ' + fnName + '(' + args + ') {');
	body.push('\tvar params = {');

	for (var i = 0; i < params.length; i += 1) {
		body.push('\t\t' + params[i] + ': ' + params[i] + (i < params.length - 1 ? ',' : ''));
	}

	body.push('\t};');
	body.push('');
	body.push('\ttry {');
	body.push('\t\thttpServer.sendCommand(' + JSON.stringify(modName + '.' + cmdName) + ', params, cb);');
	body.push('\t} catch (error) {');
	body.push('\t\tconsole.warn(' + JSON.stringify('Expected use: ' + expected) + ');');
	body.push('\t\tconsole.warn("Actual use: " + serializeActualUse(arguments));');
	body.push('\t\tthrow error;');
	body.push('\t};');
	body.push('};');

	body = body.join('\n');

	/*jshint evil:true */
	var fn;

	try {
		eval(body);
	} catch (e) {
		console.error('Error generating usercommand:', modName + '.' + cmdName);
		throw e;
	}

	return fn;
}


Mage.prototype.useModules = function () {
	var appRequire = arguments[0];

	if (typeof appRequire !== 'function') {
		throw new TypeError('useModules: the first argument must be require.');
	}

	var commands = this.config.server.commandCenter.commands;

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

		var modCommands = commands[name];

		if (modCommands && modCommands.length > 0) {
			hasImplementation = true;

			for (var j = 0; j < modCommands.length; j += 1) {
				var cmd = modCommands[j];

				mod[cmd.name] = createUserCommand(this.httpServer, name, cmd.name, cmd.params || []);
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
