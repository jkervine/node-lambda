var aws = require('aws-sdk');

var versionAliasesParams = {
  FunctionName : 'simple',
  FunctionVersion: '14' // <-- everything else works except this version ??
};
var lambda = new aws.Lambda({
  apiVersion: '2015-03-31',
		accessKeyId: 'hiddenkey',
		secretAccessKey: 'hiddensecret',
		region: 'eu-west-1'
});

var req = lambda.listAliases(versionAliasesParams);
req.on('build', function(request) {
    console.log(request.httpRequest.path);
    //path should end with ?FunctionVersion=14
});
req.send(function(err, data){
   if(err) console.log(err, err.stack);
   else {
     console.log("version aliases:",data);
   }
});


