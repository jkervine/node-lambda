'use strict';

var aws = require('aws-sdk');
var exec = require('child_process').exec;
var fs = require('fs');
var os = require('os');
var packageJson = require('./../package.json');
var path = require('path');
var async = require('async');
var zip = new require('node-zip')();
var wrench = require('wrench');
var dotenv = require('dotenv');

const MAX_FUNCTIONS_COUNT = 1024;

var Lambda = function () {
	this.version = packageJson.version;

	return this;
};

Lambda.prototype._createSampleFile = function (file) {
	var exampleFile = process.cwd() + '/' + file;
	var boilerplateFile = __dirname + '/' + file + '.example';

	if (!fs.existsSync(exampleFile)) {
		fs.writeFileSync(exampleFile, fs.readFileSync(boilerplateFile));
		console.log(exampleFile + ' file successfully created');
	}
};

Lambda.prototype.setup = function () {
	console.log('Running setup.');
	this._createSampleFile('.env');
	this._createSampleFile('event.json');
	this._createSampleFile('deploy.env');
	console.log('Setup done. Edit the .env, deploy.env, and event.json files as needed.');
};

Lambda.prototype.run = function (program) {
	this._createSampleFile('event.json');

	var splitHandler = program.handler.split('.');
	var filename = splitHandler[0] + '.js';
	var handlername = splitHandler[1];

	var handler = require(process.cwd() + '/' + filename)[handlername];
	var event = require(process.cwd() + '/' + program.eventFile);

	this._runHandler(handler, event);
};

Lambda.prototype._runHandler = function (handler, event) {
	var context = { succeed: function (result) {
		  console.log('succeed: ' + JSON.stringify(result));
		  process.exit(0);
	  },
	  fail: function (error) {
		  console.log('fail: ' + error);
		  process.exit(-1);
	  },
	  done: function () {
		  process.exit(0);
	  }
	};
	handler(event, context);
};

Lambda.prototype._params = function (program, buffer) {
	var params = { Code: {
		  ZipFile: buffer
	  },
	  FunctionName: program.functionName,
	  Handler: program.handler,
	  Role: program.role,
	  Runtime: program.runtime,
	  Description: program.description,
	  MemorySize: program.memorySize,
	  Timeout: program.timeout
	};
	return params;
};

/**
 * @deprecated
 */
Lambda.prototype._zipfileTmpPath = function (program) {
	var ms_since_epoch = +new Date();
	var filename = program.functionName + '-' + ms_since_epoch + '.zip';
	var zipfile = path.join(os.tmpDir(), filename);

	return zipfile;
};

Lambda.prototype._rsync = function (program, codeDirectory, callback) {
	exec('rsync -r --exclude=.git --exclude=*.log --exclude=node_modules . ' + codeDirectory, function (err) {
		if (err) {
			throw err;
		}

		return callback(null, true);
	});
};

Lambda.prototype._npmInstall = function (program, codeDirectory, callback) {
	exec('npm install --production --prefix ' + codeDirectory, function (err) {
		if (err) {
			throw err;
		}

		return callback(null, true);
	});
};

Lambda.prototype._zip = function (program, codeDirectory, callback) {

	var options = { type: 'nodebuffer',
	                compression: 'DEFLATE'
	};

	console.log('=> Zipping repo. This might take up to 30 seconds');
	var files = wrench.readdirSyncRecursive(codeDirectory);
	files.forEach(function (file) {
		var filePath = [codeDirectory, file].join('/');
		var isFile = fs.lstatSync(filePath).isFile();
		if (isFile) {
			var content = fs.readFileSync(filePath);
			zip.file(file, content);
		}
	});

	var data = zip.generate(options);

	return callback(null, data);
};

Lambda.prototype._nativeZip = function (program, codeDirectory, callback) {
	var zipfile = this._zipfileTmpPath(program),
	cmd = 'zip -r ' + zipfile + ' .';

	exec(cmd, {
		cwd: codeDirectory,
		maxBuffer: 50 * 1024 * 1024
	}, function (err) {
		if (err !== null) {
			return callback(err, null);
		}

		var data = fs.readFileSync(zipfile);
		callback(null, data);
	});
};

Lambda.prototype._codeDirectory = function (program) {
	var epoch_time = +new Date();

	return os.tmpDir() + '/' + program.functionName + '-' + epoch_time;
};

Lambda.prototype._setEnvironmentVars = function (program, codeDirectory) {
	console.log('=> Setting "environment variables" for Lambda from %s', program.configFile);
	// Which file is the handler?
	var handlerFileName = codeDirectory + '/' + program.handler.split('.').shift() + '.js';
	var contents = fs.readFileSync(handlerFileName);

	var configValues = fs.readFileSync(program.configFile);
	var prefix = '////////////////////////////////////\n// "Environment Variables"\n';
	var config = dotenv.parse(configValues);

	for (var k in config) {
		if (!config.hasOwnProperty(k)) {
			continue;
		}

		// Use JSON.stringify to ensure that it's valid code.
		prefix += 'process.env["' + k + '"]=' + JSON.stringify(config[k]) + ';\n';
	}
	prefix += '////////////////////////////////////\n\n';

	fs.writeFileSync(handlerFileName, prefix + contents.toString());
};

Lambda.prototype.associate = function(program) {
	if(!program.alias) {
		console.log("Please specify an alias (with --alias) to create or associate alias with function version.")
		return;
	}
	if(!program.functionVersion) {
		console.log("Please specify a version (with --function-version) with which to associate new or existing alias.")
		return;
	}
	var listAliasesParams = {
	                         FunctionName : program.functionName,
	};
	var listVersionParams = {
	                         FunctionName : program.functionName
	}
	var aliasVersionParams = {
	                          FunctionName : program.functionName,
	                          FunctionVersion : program.functionVersion,
	                          Name : program.alias
	}
	var lambda = new aws.Lambda({
		apiVersion: '2015-03-31'
	});
	async.series([function(done) {
		lambda.listVersionsByFunction(listVersionParams, function(err, data) {
			if(err) {
				console.log(err, err.stack);
				done(err,"Cannot list versions with params ", listVersionParams);
			} else {
				async.some(data.Versions, function(versionDesc, doneCompare) {
					if(versionDesc.Version == program.functionVersion) {
						doneCompare(true);
					} else {
						doneCompare(false);
					}
				}, function(result) {
					if(!result) {
						done("Cannot associate alias with version "+program.functionVersion+" since version does not exist.");
					} else {
						done(null, 1);
					}
				})
			}
		})
	},
	function(done) {
		lambda.listAliases(listAliasesParams, function(err, data) {
			if(err) {
				console.log(err, err.stack);
				done(err,"Cannot list aliases with params ", listAliasesParams);
			} else {
				async.some(data.Aliases, function(aliasDesc, doneCompare) {
					if(aliasDesc.Name == program.alias) {
						doneCompare(true);
					} else {
						doneCompare(false);
					}
				}, function(result) {
					if(!result) {
						console.log("=> Alias does not exist, creating new one...")
						lambda.createAlias(aliasVersionParams, function(err, data) {
							if(err) {
								console.log("Failed to create new alias: ",err)
								done(err, 1);
							} else {
								console.log("=> Created new alias "+program.alias+" for function "+program.functionName+" v."+program.functionVersion);
								done(null, 1);
							}
						}) 
					} else {
						console.log("=> Alias already exists, updating.");
						lambda.updateAlias(aliasVersionParams, function(err, data) {
							if(err) {
								console.log("Failed to update alias to point to version "+program.functionVersion+" : ", err);
								done(err,1);
							} else {
								console.log("=> Associating "+program.alias+" with function "+program.functionName+" version "+program.functionVersion);
								done(null,1);
							}
						})
					} 
				});
			}
		});
	}], function(err, results) {
		if(err) {
			console.log("=> Error occured when associating: ", err, err.stack);
		} else {
			console.log("=> Association created with alias " + program.alias + " and version " + program.functionVersion);
		}
	});
};

Lambda.prototype.deploy = function (program) {
	this._createSampleFile('.env');

	// Warn if not building on 64-bit linux
	var arch = process.platform + '.' + process.arch;
	if (arch !== 'linux.x64') {
		console.warn('Warning!!! You are building on a platform that is not 64-bit Linux (%s). ' +
				'If any of your Node dependencies include C-extensions, they may not work as expected in the ' +
				'Lambda environment.\n\n', arch);
	}

	var _this = this;
	var regions = program.region.split(',');
	var codeDirectory = _this._codeDirectory(program);

	console.log('=> Moving files to temporary directory');
	// Move all files to tmp folder (except .git, .log, event.json and node_modules)

	_this._rsync(program, codeDirectory, function (err) {
		if (err) {
			console.error(err);
			return;
		}
		console.log('=> Running npm install --production');
		_this._npmInstall(program, codeDirectory, function (err) {
			if (err) {
				console.error(err);
				return;
			}

			// Add custom environment variables if program.configFile is defined
			if (program.configFile) {
				_this._setEnvironmentVars(program, codeDirectory);
			}
			console.log('=> Zipping deployment package');

			var archive = process.platform !== 'win32' ? _this._nativeZip : _this._zip;
			archive = archive.bind(_this);

			archive(program, codeDirectory, function (err, buffer) {
				if (err) {
					console.error(err);
					return;
				}

				console.log('=> Reading zip file to memory');
				var params = _this._params(program, buffer);

				async.map(regions, function (region, cb) {
					console.log('=> Uploading zip file to AWS Lambda ' + region + ' ...');

					var aws_security = {
					                    accessKeyId: program.accessKey,
					                    secretAccessKey: program.secretKey,
					                    region: region
					};

					if (program.sessionToken){
						aws_security.sessionToken = program.sessionToken;
					};

					aws.config.update(aws_security);

					var lambda = new aws.Lambda({
						apiVersion: '2015-03-31'
					});

					var listFunctionParams = { MaxItems: MAX_FUNCTIONS_COUNT }
					var listVersionParams = { FunctionName: program.functionName }
					var updatedCodeParams = { FunctionName: program.functionName,
					                          ZipFile: buffer }
					var runStat = { NameExists : false,
					                Versions : [] }
					
					// deploy function, series steps first look up if the function exists
					// already and if it has version. Final step creates the new function
					// or new versio of existing function according the lookup results
					async.series([function(done) {
						lambda.listFunctions(listFunctionParams, function(err, data) {
							if (err) {
								console.log(err, err.stack); // an error occurred
								done(err,runStat);
							} else {
								console.log("=> Checking for existing implementations...")
								async.detect(data.Functions, function(functionDesc, done) {
									if(functionDesc.FunctionName == program.functionName) done(true)
									else done(false)
								}, function(functionDesc) {
									if(functionDesc) runStat.NameExists = true
									done(null,1);
								})
							}
						})
					},
					function(done) {
						lambda.listVersionsByFunction(listVersionParams, function(err, data) {
							if(err) {
								console.log(err, err.stack);
								done(err,runStat);
							}
							console.log("=> Checking for existing versions...")
							async.each(data.Versions, function(functionDesc, eachDone) {
								if(!functionDesc.Version) eachDone("Cannot find version information in "+functionDesc.FunctionName)
								else runStat.Versions.push(functionDesc.Version)
								eachDone()
							}, function(err) {
								if(!err) done(null, 2)
								else done("Error in looking up versions: "+err, runStat);
							})
						})
					},
					function(done) {
						if(runStat.NameExists) {
							console.log("=> Function with name "+program.functionName+" exists.")
							if(runStat.Versions.indexOf(program.functionVersion) == -1) {
								console.log("=> Version \'"+program.functionVersion+"\' does not exist. Updating code in $LATEST and publishing...")
								lambda.updateFunctionCode(updatedCodeParams, function(err, data) {
									if(err) {
										done("Failed to update function code : "+err);
									} else {
										lambda.publishVersion({FunctionName: program.functionName}, function(err, data) {
											if(err) done("Failed to publish new version : "+err);
											else done(null, 3);
										})
									}
								})
							} else {
								cb("Function Already deployed and version "+program.functionVersion+" already exists!",null)
							}
						} else {
							lambda.createFunction(params, function (err, data) {
								if(!err) done(null, 3);
								else cb(err, data);
							})
						}
					}],
					function(err,results) {
						cb(err, results);
					});
				}, function (err, results) {
					if (err) {
						console.error(err);
					} else {
						console.log('=> Done uploading.');
					}
				});
			});
		});
	});
};

module.exports = new Lambda();
