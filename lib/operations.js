'use strict';
var async = require('async');

const MAX_FUNCTIONS_COUNT = 1024;

function listVersionsByFunction(program, client, stop) {
	var listVersionParams = {
	  FunctionName : program.functionName
	}
	console.log("=> Listing versions...");
	client.listVersionsByFunction(listVersionParams, function(err, data) {
		if(err && err.code == 'ResourceNotFoundException') {
			console.log("=> No previous implementation");
			stop(null, [])
		} else if(err) {
			console.log(err, err.stack);
			stop(err,"Cannot list versions with params ", listVersionParams);
		} else {
			async.some(data.Versions, function(versionDesc, doneCompare) {
				if(versionDesc.Version == program.functionVersion) {
					doneCompare(true);
				} else {
					doneCompare(false);
				}
			}, function(result) {
				if(!result) {
					stop(null, []);
				} else {
					stop(null, data.Versions);
				}
			});
		}
	}); 
}

function checkFunctionExists(program, client, stop) {
	var listFunctionParams = { MaxItems: MAX_FUNCTIONS_COUNT }
	client.listFunctions(listFunctionParams, function(err, data) {
		if (err) {
			console.log(err, err.stack);
			done(err,runStat);
		} else {
			console.log("=> Checking for existing implementations...")
			async.detect(data.Functions, function(functionDesc, detectDone) {
				if(functionDesc.FunctionName == program.functionName) detectDone(true)
				else detectDone(false)
			}, function(functionFound) {
				if(functionFound) stop(null, true)
				else stop(null, false);
			})
		}
	})
}

module.exports = {
  listVersionsByFunction : listVersionsByFunction,               
  checkFunctionExists : checkFunctionExists
}