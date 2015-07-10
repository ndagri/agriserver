'use strict';

var fs = require('fs');
var crypto = require("crypto");

var logger, models, baucis, config, passport, userModel;

var api = {
    _config: undefined,

    config: function(pluginConfig) {
        this._config = pluginConfig;
        logger = pluginConfig.logger;        
        baucis = pluginConfig.baucis;
        passport = pluginConfig.passport; 
        config = pluginConfig.server_config;

        var modelConfig = {
            mongoose: pluginConfig.mongodb,
            logger: logger
        };

        if (config.teranaut && config.teranaut.models) {
            models = require(config.teranaut.models)(modelConfig);    
        }
        else {
            models = require('./server/models')(modelConfig);    
        }
        
        if (config.teranaut && config.teranaut.auth && config.teranaut.auth.user_model) {
            userModel = models[config.teranaut.auth.user_model];
        }
        else {
            userModel = models.User;
        }
        
    },

    static: function() {
        return __dirname + '/static';
    },

    init: function() {

        if (! (config.teranaut && config.teranaut.models)) {
            // Configure Baucis to know about the application models
            require('./server/api/baucis')(this._config);
        }
        //var user = models.User;

        passport.use(userModel.createStrategy());
        passport.serializeUser(userModel.serializeUser());
        passport.deserializeUser(userModel.deserializeUser());
    },

    pre: function() {
        this._config.app.use(passport.initialize());
        this._config.app.use(passport.session());
    },

    routes: function(deferred) {
        // Login function to generate an API token
        this._config.app.use('/api/v1/token', login);
        this._config.app.use('/api/v1/login', login);

        // All API endpoints require authentication
        this._config.app.use('/api/v1', ensureAuthenticated);

        // THIS needs to be deferred until after all plugins have had a chance to load
        var config = this._config;
        deferred.push(function() {
            config.app.use('/api/v1', baucis());
        })

        this._config.app.post('/login', passport.authenticate('local'), function(req, res) {
            //res.redirect('/');
            res.status(200).send('login successful');
        });

        this._config.app.get('/logout', function(req, res) {
            req.logout();
            //res.redirect('/');
            res.status(200).send('login successful');
        });
    },

    post: function() {

    }
};

var ensureAuthenticated = function(req, res, next) {
    // We allow creating new accounts without authentication.    
    if (config.get('teranaut_auth').open_signup) {
        // TODO: THIS URL should depend on the name of the model
        if (req.url === '/accounts' && req.method === 'POST') return next();    
    }
    
    // See if the session is authenticated
    if (req.isAuthenticated()) {
        return next();
    }
    // API auth based on tokens
    else if (req.query.token) {
        userModel.findOne({api_token: req.query.token}, function(err, account) {
            if (err) {
                throw err;
            }

            if (account) {
                req.user = account;
                
                // If there's redis session storage available we add the login to the session.
                if (config.teraserver && config.teraserver.redis_sessions) {        
                    req.logIn(account, function(err) {
                        if (err) {
                            return next(err);
                        }

                        return next();
                    });
                }
                else {
                    return next();
                }
            }
            else {
                return res.status(401).json({ error: 'Access Denied' });
            }
        })
    }
    else {
        // For session based auth

        //res.redirect('/login')
        return res.status(401).json({ error: 'Access Denied' });
    }
}

var login = function(req, res, next) {

    passport.authenticate('local', { session: false }, function(err, user, info) {

        if (err) {
            return next(err);
        }

        if (! user) {
            return res.status(401).json({ error: info.message });
        }

        if (config.teranaut.auth && config.teranaut.auth.require_email && ! user.email_validated) {            
            return res.status(401).json({ error: 'Account has not been activated' });
        }

        req.logIn(user, function(err) {
            if (err) {
                return next(err);
            }

            var shasum = crypto.createHash('sha1');
            var date = Date.now();
            crypto.randomBytes(128, function(err, buf) {
                if (err) {
                    logger.error("Error generating randomBytes on User save.");
                    return next(err);
                }

                shasum.update(buf + Date.now() + user.hash + user.username);
                var token = shasum.digest('hex');
                user.api_token = token;
                user.save();
                res.json({
                    token: token,
                    date: date,
                    id: user._id
                });
            });
        });
    })(req, res, next);
}

module.exports = api;
