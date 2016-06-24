'use strict';

var ejs = require('ejs');
var dateformat = require('dateformat');
var crypto = require('crypto');
var async = require('async');
var fs = require("fs");
var chalk = require('chalk');
var path = require('path');
var mkdirp = require('mkdirp');

var exec;


ejs.open = "{{";
ejs.close = "}}";

var cwd = __dirname;

var createFile = function (template, options) {
    var outerMetadata = fs.readFileSync(path.resolve(cwd, '../template/' + template)).toString();
    var metadata = ejs.render(outerMetadata, options);
    return metadata;
};

var md5 = function (str) {
    var hash = crypto.createHash('md5');
    return hash.update(str).digest('hex');
};

var sha1 = function (str) {
    var hash = crypto.createHash('sha1');
    return hash.update(str).digest('hex');
};

var save = function (fileContent, pomDir, fileName) {
    mkdirp.sync(pomDir);
    fs.writeFileSync(pomDir + '/' + fileName, fileContent);
    fs.writeFileSync(pomDir + '/' + fileName + '.md5', md5(fileContent));
    fs.writeFileSync(pomDir + '/' + fileName + '.sha1', sha1(fileContent));
};

var directoryExists = function(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    } catch (e) {
        // error is thrown by statSync when path does not exist
        if (e.code === 'ENOENT') {
            return false
        }
        throw e;
    }
};

var createAndUploadArtifacts = function (options, done) {
    var pomDir = options.pomDir || 'test/poms';

    options.parallel = options.parallel === undefined ? false : options.parallel;
    if (!directoryExists(pomDir)) {
        fs.mkdirSync(pomDir);
    }

    var artifacts = [];
    if (options.artifacts) {
        artifacts = options.artifacts;
    }
    if (options.artifact) {
        artifacts.push({
            artifact: options.artifact,
            packaging: options.packaging,
            classifier: options.classifier
        });
    }

    save(createFile('project-metadata.xml', options), pomDir, 'outer.xml');
    save(createFile('latest-metadata.xml', options), pomDir, 'inner.xml');
    save(createFile('pom.xml', options), pomDir, 'pom.xml');

    var upload = function (fileLocation, targetFile) {
        var uploadArtifact = function (cb) {
            var targetUri = options.url + '/' + targetFile, status;
            if (!options.quiet) {
                console.log(chalk.blue('Uploading to ' + targetUri + "\n\n"));
            }

            var curlOptions = [
                '--silent',
                '--output', '/dev/stderr',
                '--write-out', '"%{http_code}"',
                '--upload-file', fileLocation,
                '--noproxy', options.noproxy ? options.noproxy : '127.0.0.1'
            ];

            if (options.auth) {
                curlOptions.push('-u');
                curlOptions.push('"'+options.auth.username + ":" + options.auth.password+'"');
            }

            if (options.insecure) {
                curlOptions.push('--insecure');
            }

            var execOptions = {};
            options.cwd && (execOptions.cwd = options.cwd);

            var curlCmd = ['curl', curlOptions.join(' '), targetUri].join(' ');

            var childProcess = exec(curlCmd, execOptions, function () {
            });
            childProcess.stdout.on('data', function (data) {
                status = data;
            });
            childProcess.on('close', function (code) {
                if (status.substring(0, 1) == "2" || code == 0) {
                    cb(null, "Ok");
                } else  {
                    cb("Status code " + status + " for " + targetUri, null);
                }
            });
        };
        return uploadArtifact;
    };

    var uploads = {};

    var groupIdAsPath = options.groupId.replace(/\./g, "/");
    var groupArtifactPath = groupIdAsPath + '/' + options.artifactId;

    uploads[pomDir + "/outer.xml"] = groupArtifactPath + '/' + 'maven-metadata.xml';
    uploads[pomDir + "/outer.xml.sha1"] = groupArtifactPath + '/' + 'maven-metadata.xml.sha1';
    uploads[pomDir + "/outer.xml.md5"] = groupArtifactPath + '/' + 'maven-metadata.xml.md5';

    var SNAPSHOT_VER = /.*SNAPSHOT$/i;

    var groupArtifactVersionPath = groupArtifactPath + '/' + options.version;
    if (SNAPSHOT_VER.test(options.version)) {
        uploads[pomDir + "/inner.xml"] = groupArtifactVersionPath + '/' + 'maven-metadata.xml';
        uploads[pomDir + "/inner.xml.sha1"] = groupArtifactVersionPath + '/' + 'maven-metadata.xml.sha1';
        uploads[pomDir + "/inner.xml.md5"] = groupArtifactVersionPath + '/' + 'maven-metadata.xml.md5';
    }

    var artifactBaseName = options.artifactId + '-' + options.version;
    uploads[pomDir + "/pom.xml"] = groupArtifactVersionPath + '/' + artifactBaseName + '.pom';
    uploads[pomDir + "/pom.xml.sha1"] = groupArtifactVersionPath + '/' + artifactBaseName + '.pom.sha1';
    uploads[pomDir + "/pom.xml.md5"] = groupArtifactVersionPath + '/' + artifactBaseName + '.pom.md5';

    artifacts.forEach(function (artifact) {
        var artifactName;
        if (artifact.classifier) {
            artifactName = artifactBaseName + "-" + artifact.classifier + "." + artifact.packaging;
        } else {
            artifactName = artifactBaseName + "." + artifact.packaging;
        }

        uploads[artifact.artifact] = groupArtifactVersionPath + '/' + artifactName;

        var artifactData = fs.readFileSync(artifact.artifact, {encoding: 'binary'});
        var artifactMd5File = pomDir + '/artifact.' + artifactName + '.md5';
        fs.writeFileSync(artifactMd5File, md5(artifactData));
        uploads[artifactMd5File] = groupArtifactVersionPath + '/' + artifactName + '.md5';

        var artifactSha1File = pomDir + '/artifact.' + artifactName + '.sha1';
        fs.writeFileSync(artifactSha1File, sha1(artifactData));
        uploads[artifactSha1File] = groupArtifactVersionPath + '/' + artifactName + '.sha1';
    });

    var fns = [];
    for (var u in uploads) {
        if (uploads.hasOwnProperty(u)) {
            fns.push(upload(u, uploads[u]));
        }
    }

    var asyncFn = options.parallel ? async.parallel : async.series;
    asyncFn(fns, function (err) {
        if (!options.quiet) {
            console.log(chalk.blue('-------------------------------------------\n'));
            if (err) {
                console.log(chalk.red('Artifact Upload failed\n' + String(err)));
            } else {
                console.log(chalk.green('Artifacts uploaded successfully'));
            }
        }
        done(err);
    });

};

module.exports = function (options, cb) {
    if (!options) {
        throw {name: "IllegalArgumentException", message: "upload artifact options required."};
    }
    exec = process.env.MOCK_NEXUS ? require('./mockexec') : require('child_process').exec;
    options.lastUpdated = process.env.MOCK_NEXUS ? '11111111111111': dateformat(new Date(), "yyyymmddHHMMss");
    createAndUploadArtifacts(options, cb);
};