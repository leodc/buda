// Buda Manager
// ============
// Handle a graph of subprocesses for data manipulation on
// specific zones and provides a REST interface for management.
//
// Available commands:
//    getZoneList        GET /
//    getZoneDetails     GET /{id}
//    updateZone         PUT /{id}
//    updateZone         PATCH /{id}
//    deleteZone         DELETE /{id}
//    registerZone       POST /
//    ping               GET /ping

// Enable strict syntax mode
'use strict';

// Load required modules
var _        = require( 'underscore' );
var fs       = require( 'fs' );
var Hapi     = require( 'hapi' );
var crypto   = require( 'crypto' );
var spawn    = require( 'child_process' ).spawn;
var info     = require( '../package' );
var colors   = require( 'colors/safe' );
var bunyan   = require( 'bunyan' );

// Utility method to calculate a zone ID
function getID( zone ) {
  var shasum = crypto.createHash( 'sha1' );
  var digest = '|';
  digest += zone.version + '|';
  digest += zone.metadata.name + '|';
  digest += zone.metadata.description + '|';
  digest += zone.metadata.organization + '|';
  digest += zone.data.type + '|';
  digest += zone.storage.type + '|';
  digest += zone.hotspot.type + '|';
  
  shasum.update( digest );
  return shasum.digest( 'hex' );
}

// Constructor method
function BudaManager( config ) {
  // Runtime zones list
  this.zones = [];
  
  // Runtime agents list
  this.agents = [];
  
  // Runtime configuration holder
  this.config = _.defaults( config, BudaManager.DEFAULTS );
  
  // App logging interface
  this.logger = bunyan.createLogger({
    name: 'buda-manager',
    stream: process.stdout,
    level: 'debug'
  });
  
  // API interface
  this.restapi = new Hapi.Server({
    minimal: true,
    load: { 
      sampleInterval: 5000
    }
  });
}

// Default config values
// - The 'home' directory must be readable and writable by the user
//   starting the daemon.
// - Only 'root' can bind to ports lower than 1024 but running this
//   process as a privileged user is not advaised ( or required )
BudaManager.DEFAULTS = {
  home: '/home/buda/',
  port: 8000,
  list: 'zones.conf'
};

// Apply verifications to the home/working directory
BudaManager.prototype._verifyHome = function() {
  this.logger.debug( 'Check home directory exist' );
  if( ! fs.existsSync( this.config.home ) ) {
    this.logger.fatal( 'Home directory does not exist' );
    process.exit();
  }
  
  this.logger.debug( 'Check home directory is readable and writeable' );
  try {
    // Disable this check, the singe | character is required
    // for the bitmask according to the API
    // jshint -W016
    fs.accessSync( this.config.home, fs.R_OK | fs.W_OK );
  } catch( err ) {
    this.logger.fatal( err, 'Invalid permissions' );
    process.exit();
  }
};

// Setup REST interface
BudaManager.prototype._startInterface = function() {
  // Config connection socket
  this.restapi.connection({
    host: 'localhost', 
    port: this.config.port
  });
  
  // Attach REST routes to commands
  var self = this;
  this.restapi.route([
    {
      method: 'GET',
      path:'/ping', 
      handler: function( request, reply ) {
        self.logger.info( 'Request: Healt check' );
        self.logger.debug({
          params: request.params,
          headers: request.headers
        }, 'Request details' );
        reply( 'pong' );
      }
    },
    {
      method: 'GET',
      path:'/', 
      handler: function( request, reply ) {
        self.logger.info( 'Request: Retrieve zone list' );
        self.logger.debug({
          params: request.params,
          headers: request.headers
        }, 'Request details' );
        reply( self._getZoneList() );
      }
    },
    {
      method: 'GET',
      path:'/{id}', 
      handler: function( request, reply ) {
        self.logger.info( 'Request: Retrieve zone details' );
        self.logger.debug({
          params: request.params,
          headers: request.headers
        }, 'Request details' );
        reply( self._getZoneDetails( request.params.id ) );
      }
    },
    {
      method: 'PUT',
      path:'/{id}', 
      handler: function( request, reply ) {
        self.logger.info( 'Request: Update zone' );
        self.logger.debug({
          params: request.params,
          headers: request.headers
        }, 'Request details' );
        reply( self._updateZone( request.params.id, request.payload.zone ) );
      }
    },
    {
      method: 'PATCH',
      path:'/{id}', 
      handler: function( request, reply ) {
        self.logger.info( 'Request: Update zone' );
        self.logger.debug({
          params: request.params,
          headers: request.headers
        }, 'Request details' );
        reply( self._updateZone( request.params.id, request.payload.zone ) );
      }
    },
    {
      method: 'DELETE',
      path:'/{id}', 
      handler: function( request, reply ) {
        self.logger.info( 'Request: Delete zone' );
        self.logger.debug({
          params: request.params,
          headers: request.headers
        }, 'Request details' );
        reply( self._deleteZone( request.params.id ) );
      }
    },
    {
      method: 'POST',
      path:'/', 
      handler: function( request, reply ) {
        self.logger.info( 'Request: Create zone' );
        self.logger.debug({
          params: request.params,
          headers: request.headers
        }, 'Request details' );
        reply( self._registerZone( request.payload.zone ) );
      }
    },
    {
      method: '*',
      path:'/{p*}', 
      handler: function( request, reply ) {
        self.logger.warn( 'Bad request: %s %s', request.method, request.path );
        self.logger.debug({
          params: request.params,
          headers: request.headers
        }, 'Request details' );
        reply( { error: true, desc: 'INVALID_REQUEST' } );
      }
    }
  ]);
  
  // Open connections
  this.restapi.start();
};

// Starts a new zone agent
BudaManager.prototype._startAgent = function( zone ) {
  // Setup
  var bin  = 'buda-agent-' + zone.data.type;
  var conf = {};
  conf.id      = zone.id;
  conf.data    = zone.data.options;
  conf.storage = zone.storage.options;
  conf.hotspot = zone.hotspot;
  
  // Create agent
  var agent = spawn( bin, ['--conf', JSON.stringify( conf ) ] );
  this.logger.info( 'Starting agent: %s', agent.pid );
  this.logger.debug({
    configuration: conf
  }, 'Starting agent: %s with configuration', agent.pid );
  
  // Create child logger for each individual agent
  agent.logger = this.logger.child({
    agent: agent.pid,
    zone: zone.id
  });
  
  // Catch information on the agent output
  agent.stdout.on( 'data', function( msg ) {
    try {
      msg = JSON.parse( msg );
      if( msg.details ) {
        agent.logger[msg.level]( msg.details );
      } else {
        agent.logger[msg.level]( msg.desc );
      }
    } catch( e ) {
      agent.logger.error( 'Error decoging: %s', msg );
    }
  });
  
  // If the agent die; remove it from the list
  agent.on( 'exit', _.bind( function() {
    this.logger.info( 'Removing agent: %s', agent.pid );
    this.agents.splice( _.indexOf( this.agents, agent ), 1 );
  }, this ) );
  
  // Add agent and attach process PID to the zone
  this.agents.push( agent );
  zone.agentPID = agent.pid;
};

// Retrive a list of all zones in play
BudaManager.prototype._getZoneList = function() {
  return this.zones;
};

// Retrieve details of a specific zone
BudaManager.prototype._getZoneDetails = function( id ) {
  // Retrieve element from this.zones based on it's id
  var zone = _.findWhere( this.zones, { id: id });
  if( ! zone ) {
    this.logger.warn( 'Invalid zone id: %s', id );
    return { error: true, desc: 'INVALID_ZONE_ID' };
  }
  
  return zone;
};

// Update and existing zone
BudaManager.prototype._updateZone = function( id, newData ) {
  // Retrieve element from this.zones based on it's id
  var zone = _.findWhere( this.zones, { id: id });
  if( ! zone ) {
    this.logger.warn( 'Invalid zone id: %s', id );
    return { error: true, desc: 'INVALID_ZONE_ID' };
  }
  
  // Stop zone agent
  process.kill( zone.agentPID, 'SIGINT' );
  this.zones.splice( _.indexOf( this.zones, zone ), 1 );
  
  // Create zone with newData
  return this._registerZone( newData );
};

// Delete a running zone
BudaManager.prototype._deleteZone = function( id ) {
  // Retrieve element from this.zones based on it's id
  var zone = _.findWhere( this.zones, { id: id });
  if( ! zone ) {
    this.logger.warn( 'Invalid zone id: %s', id );
    return { error: true, desc: 'INVALID_ZONE_ID' };
  }
  
  // Stop zone agent
  process.kill( zone.agentPID, 'SIGINT' );
  
  // Remove
  this.logger.info( 'Remove zone: %s', zone.id );
  this.logger.debug({
    zone: zone
  }, 'Remove zone: %s', zone.id );
  this.zones.splice( _.indexOf( this.zones, zone ), 1 );
  
  return zone;
};

// Register a new zone
BudaManager.prototype._registerZone = function( zone ) {
  // Calculate ID
  zone.id = getID( zone );
  
  // Spawn agent based on zone.data.type
  this._startAgent( zone );
  
  // Add zone to the list
  this.zones.push( zone );
  
  this.logger.info( 'Zone created: %s', zone.id );
  this.logger.debug({
    zone: zone
  }, 'Zone created: %s', zone.id );
  return zone;
};

// Gracefully shutdown
BudaManager.prototype._cleanUp = function() {
  // Stop running agents
  this.logger.info( 'Stopping running agents' );
  _.each( this.agents, function( agent ) {
    process.kill( agent.pid, 'SIGINT' );
  });
  
  // Exit main process;
  // Give 350ms to each agent to gracefully close too
  setTimeout( _.bind( function(){
    this.logger.info( 'Exiting Manager' );
    process.exit();
  }, this ), this.agents.length * 350 );
};

// Show usage information
BudaManager.prototype.printHelp = function() {
  console.log( colors.green.bold( 'Buda Manager ver. ' + info.version ) );
  console.log( colors.white.bold( 'Available configuration options are:' ) );
  _.each( BudaManager.DEFAULTS, function( val, key ) {
    console.log( colors.gray( '\t' + key + '\t' + val ) );
  });
};

// Kickstart for the daemon process
BudaManager.prototype.start = function() {
  // Looking for help ?
  if( _.has( this.config, 'h' ) || _.has( this.config, 'help' ) ) {
    this.printHelp();
    process.exit();
  }
  
  // Log config
  this.logger.info( 'Buda Manager ver. ' + info.version );
  this.logger.debug({
    config: this.config
  }, 'Starting with configuration' );
  
  // Home directory validations
  this.logger.info( 'Verifying working directory' );
  this._verifyHome();
  
  // Move process to working directory
  this.logger.info( 'Moving process to working directory' );
  process.chdir( this.config.home );
  
  // Start REST interface
  this.logger.info( 'Starting REST interface' );
  this._startInterface();
  this.logger.debug({
    config: this.restapi.info
  }, 'Interface started with configuration' );
  
  // Log final output
  this.logger.info( 'Initialization process complete' );
  
  // Listen for interruptions and gracefully shutdown
  process.stdin.resume();
  process.on( 'SIGINT', _.bind( function() {
    this._cleanUp();
  }, this ));
};

module.exports = BudaManager;