/****

mimic - a roll20.net api script to teach any selected token to reproduce any player chat message.
version: 0.3 beta Jun 1 2015
author:  Ed B. My first roll20 script!
         function fixupCommand donated by manveti
         additional code design advice thanks to The Aaron and Brian but the bad stuff is all on me. 
license: GPL 3.0 with optional attribution. details in LICENSE file.

Usage:  !mimic [opts] [cmd]
cmd is one of:
    -learn selected tokens learn the most recent chat message sent by the player issuing this mimic. 
    -perform this is the default command if no cmd is given. The selected tokens will "perform" meaning they will 
           mimic a chat message previously -learned
    -buttons install example of useful token buttons for !mimic. GM only.
    -dump dump all learned actions to the log for debugging. GM only
    -reset recover state space by forgetting all learned actions. GM only.
    -clean recover state space by forgetting actions of deleted tokens. GM only.
opts are:
 ***-n where n is a single digit 0-9. Use token's nth of 10 action memories. Default is memory 0.
 -whisper force the token to whisper to the gm. also whisper script notifications to gm.
              useful to test a token's command memory without alerting players.
 -shout force the token to NOT whisper. Useful when the token was taught by whisper-ing.
 -quiet suppress all chat notification of script activity
 -bar1 [or -bar2 or -bar3] decrement bar value when you do a perform. For ammo tracking

 *** == NOT YET IMPLEMENTED
 * === NOT YET TESTED

Coding strategy:
  1. last player msg stored
  2. token learns message by copying players to persistent wrapper
  3. token perform message from wrapper data

KNOWN ISSUES:
// token prevented from learing api calls. Prevents cascade failures 
           in learning/performing cycles
//         also prevents strange api interaction.
// mimic gets confused by some obscure chat sequences, but apparently keeps on truckin'.
// not sure the way I'm applying template is comprehensive. I only do D&D 5e and that works. What about powercard, etc?
// Tried attaching directly to objects instead of using state, but data would
not persist. Wrapping the token objects with a generalized state object. 
// dev team could inform if there'a a hook to check on how much state space I'm taking up. 
What happens if I blow this up?
// copying a token is going to be a pain to code. No way to tell what was selected. 
Searching for similar token may pick the wrong one to copy learned stuff.

TODO LOG: 
done // modularize and structure code
done // steal/code an option parser.
fixed // bug if no cmd recorded for player
done // clean up msg traces on token destruction with !mimic -clean and !mimic -reset
// copy memory on create token -. copy chracter token -. copy closest onscreen token
// -n option push a stack of learned behaviours
done // add --quiet and --whisperNoticestogm
// figure some way to label the token actions for the players
not worth effort // substitute token info (?name ?who) into cmd labels/title
done // make sure re-rolls do not cascade (?who) 
too messy // create a shortcut with backquote-command
// confirm clean operation works

done // code revisions suggested by Aaron re undefined and calls
done // fix whispers back to player
// decrement on a bar
// exclude character tokens
// add a "*no selected token*" memory slot; not sure what message should be. 
Will disappear on cleaning.

***/

var edMsgUtils = edMsgUtils || (function(){

	// inline rolls substitution function authored by manveti
	function fixupCommand(cmd, inlineRolls) {
		function replaceInlines(s) {
			if (!inlineRolls) {
				return s;
			}
			var i = parseInt(s.substring(3, s.length - 2));
			if ((i < 0) || (i >= inlineRolls.length) || (!inlineRolls[i])
					|| (!inlineRolls[i]['expression'])) {
				return s;
			}
			return "[[" + inlineRolls[i]['expression'] + "]]";
		}
		return cmd.replace(/\$\[\[\d+\]\]/g, replaceInlines);
	}

	function substituteRolls(msg) {
		return fixupCommand(msg.content, msg.inlinerolls || []);
	}
	function prefixTemplate(msg) {
		if (!msg.rolltemplate)
			return "";
		return "&{template:" + msg.rolltemplate + "} ";
	}

	function prefixCmd(msg) {
		function targTrimName(msg){
			// whisper only works on trimmed name of a player as of May 2015
			// when fixed, this will work on target_name
			// return '/w "' + msg.target_name + '" ';
			if( ! msg.target ) return "";
			if( msg.target === "gm" ) return "gm";
			// multiple targets if a character whisper - pick first entry from targets
			var targPlayer = getObj('player', msg.target.split(",")[0] );
			if(!targPlayer) return "gm"; // error
			return targPlayer.get('_displayname').split(/\s+/)[0];						
		}

		// return ""; // fix this code
		switch (msg.type) {
		case "rollresult":
			return "/roll "; // reproduce /r /roll
		case "gmrollresult":
			return "/gmroll "; // reproduce /gmroll
		case "emote":
			return "/em "; // reproduce /emote
		case "whisper":			
			return "/w " + targTrimName(msg) + " "; // until whisper to characters is available
		case "desc":
			return "/desc ";
		case "api":
		case "general":
		default:
			return "";
		}
		return "";
	}

	// convert a msg back into a cmd string so it can be reproduced
	//	as a chat message
	// try to reconstruct the message string based on type.
	// known issues:
	// (1) no way to detect a backquote literal message, macro, api or ability/attr calls
	// (2) some types are not reconstructable exactly: /gmroll /as /emas / for example
	// (3) inline rolls are not expanded correctly if the playerid is API ?? weird ??
	// (4) whispers to character don't work on the server side api as of May 10 2015
	// (5) I am unclear as to whispers to multiple players, does it exist outside of characters, hard to mimic
	var msgToCmdstring = function(msg) {
		switch (msg.type) {
		case "rollresult": // reproduce /r /roll
		case "gmrollresult": // reproduce /gmroll
			cmdstring = prefixCmd(msg) + msg.origRoll;
			break;
		case "general":
		case "emote":
		case "whisper":
		case "desc":
		case "api":
			cmdstring = prefixCmd(msg) + prefixTemplate(msg) + substituteRolls(msg);
			break;
		default:
			cmdstring = "Unknown chat message type: " + msg.type;
		}
		return cmdstring;
	}; // end msgToCmdstring

	function whisperize(msg){
		// destructively convert message to a whisper
		// can only convert to gm whispers. 
		switch(msg.type){
		case "rollresult": // reproduce /gmroll
			msg.type = "gmrollresult";
			break;
		case "emote":
		case "general":
		case "desc":
			msg.type = "whisper";
			break;
		case "api":
		default:
		}		
		return msg;
	}

	function dewhisperize(msg){
		// destructively convert message to NOT whisper
		switch(msg.type){
		case "gmrollresult": // reproduce /gmroll
			msg.type = "rollresult";
			break;
		case "whisper":
			msg.type = "general";
			break;
		default:
		}
		return msg;
	}
	return { // public methods
		Revert: msgToCmdstring,
		toWhisper : whisperize,
		toShout : dewhisperize		
	};	
})();

var mimicModule = mimicModule || (function(){

	// the individual command opt flags for this script are stored in these c-variables.
	// But this data has to be reset on each event since there is only one module object.
	// I assume calls to the api are synchronized. If not, these option data need to
	// be duplicated in separate evaluation contexts (new objects?) for each 
	// api caller event and then synchronized. Now its classy, but not very OOP.  

	var	cQuietFlag = false;
	var	cWhisperFlag = false;
	var	cShoutFlag = false;
	var cBarNumber = null;

	function acousticAdjust(msg){ //note _.clone is shallow
		if(! msg ) return null;
		if( cWhisperFlag ) return edMsgUtils.toWhisper(_.clone(msg));
		if( cShoutFlag ) return edMsgUtils.toShout(_.clone(msg));
		return msg;	
	}	

	// persistent wappers for tokens maintained in roll20 state variable.
	// graphic object are not persisted so, use this instead.
	var pwTokens = (function(){
		// tokens in state
		if ( ! _.isObject(state.pwTokStorage) ) state.pwTokStorage = {};

		function get_PWToken( tokid ){ // create if necessary
			// check the state variable
			if( state.pwTokStorage[tokid] ) return state.pwTokStorage[tokid];

			var token = getObj('graphic', tokid);
			if( token ){
				var pwToken = new WrappedToken(tokid);
				state.pwTokStorage[tokid] = pwToken;
				return pwToken;
			}
			return null; // failed to find token
		}

		var WrappedToken = function( token_id ){
			// this._token = token; // using token, but scared about deserialization
			this._tokenid = token_id; // possibly this should be an _id, not a token ref, also allow GC
			this.autoBarDec = null;  // permitted properties
			this.learned = null;
		};
		WrappedToken.prototype.get = function( property ){  // accessors would be better. JS version?
			if( _.has(this, property) ) return this[property];
			return getObj('graphic',this._tokenid).get(property); // dereference and delegate to wrapped token
		};
		WrappedToken.prototype.set = function( property, value ){
			if( _.has(this, property) ){
				this[property] =  value;
				return value;
			}
			else return getObj('graphic',this._tokenid).set( property, value ); // delegate
		};

		function resetStorage(){
			state.pwTokStorage = {};
		};
		function cleanStorage(){ // delete keys that aren't roll20 tokens and restore prototypes
			for (var objid in state.pwTokStorage) {
				if (state.pwTokStorage.hasOwnProperty(objid))
					if(getObj('graphic',objid)){ // restore prototypes HACK! NON STANDARD JS!
						state.pwTokStorage[objid].__proto__ = WrappedToken.prototype;
					}
					else {
						if(! delete state.pwTokStorage[objid] )
							log("!mimic script: JS delete failed in pwTokens.cleanStorage");
					}
			}
		};

		return {
			data : function(){ return state.pwTokStorage; }, // for debugging
			reset : resetStorage,
			clean : cleanStorage,
			getPWToken : get_PWToken
		};
	})();

	// object log last player message during a session; but doesn't have to be persistent.
	var msgLog = (function(){
		var msgHist = {}; // initialize log
		return {
			update : function (msg, logid){
				logid = logid || msg.playerid;
				oldlog = msgHist[logid];
				msgHist[logid] = msg;
				return oldlog;
			},
			retreive : function ( logid ){
				return msgHist[logid];
			}
		};
	})();
	
	//	enforce persistent data as a singleton member of state	
	state.mimicMsgStore = {}; // old stuff

	// script reporting to user
	var sendNote = function(noticeString, msgOrigin, whofrom) {
		// can't whisper to players form api as of May 2015, so unfortunately whoto doesn't work
		// change to whisper to who when available.
		if( cQuietFlag ) return;

		var prefix = "";
		if(!msgOrigin && cWhisperFlag ) prefix = "/w GM "; // don't know who to whisper => whisper to GM
		if(msgOrigin){ // whisper back to origin
			// check for GM first
			if( msgOrigin.who.indexOf("(GM)") !== -1 ) prefix = "/w GM ";
			else {	
				var targPlayer = getObj('player', msgOrigin.playerid ); // don't use who - could be token or character
				prefix = "/w " + targPlayer.get('_displayname').split(/\s+/)[0] + " ";
			}
		}
		if( cShoutFlag ) prefix = ""; // if cShoutFlag, override whispers

		whofrom = whofrom || "Mimic script" ;
		sendChat(whofrom, prefix + noticeString);
	};

	var handleMsgInput = function(msg) {

		// var msgStore = msgStorage.getStore();

		// if this is a player's message, put it in storage for later mimicing.
		// Could put this in a separate handler from !mimic.
		// No apis allowed prevents cascade failures. (this may be overly cautious.)	
		if (msg.type !== "api" && 'playerid' in msg && msg.content.indexOf("!mimic") === -1) {
			// msgStore[msg.playerid] = msg; // not cloning it seems to persist OK.
			// log(msg);
			msgLog.update(msg); // log it
			return; // only !mimic needs to make it further
		}

		if (msg.type !== "api" || msg.content.indexOf("!mimic") === -1) return;
		// fall through must be !mimic - parse the opts	

		var opFunc = performOperation; // reset defaults
		cQuietFlag = false;
		cWhisperFlag = false;
		cShoutFlag = false;
		cBarNumber = null;
		
		var operationCount = 0;

		var args = msg.content.split(/\s+/);

		for(var i=1; i<args.length; i++)
			switch(args[i]){
			case "-dump":
				opFunc = dumpOperation;
				operationCount++;
				break;
			case "-learn":
				opFunc = learnOperation;
				operationCount++;
				break;
			case "-perform":
				opFunc = performOperation;
				operationCount++;
				break;
			case "-buttons":
				opFunc = buttonsOperation;
				operationCount++;
				break;
			case "-reset":
				opFunc = resetOperation;
				operationCount++;
				break;
			case "-clean":
				opFunc = cleanOperation;
				operationCount++;
				break;
			case "-shout":
				cShoutFlag = true;
				cWhisperFlag = false;
				break;
			case "-quiet":
				cQuietFlag = true;
				break;
			case "-whisper":
				cWhisperFlag = true;
				cShoutFlag = false;
				break;
			case "-bar3":
				cBarNumber = "3";
				break;
			case "-bar2":
				cBarNumber = "2";
				break;
			case "-bar1":
				cBarNumber = "1";
				break;
			default:
				operationCount++;
			opFunc = function(){ sendNote("Unknown operation or command"); };
			}

		if(operationCount > 1){
			sendNote("too many command options given.");
			return ;
		}		
		opFunc(msg);    
	};

	function learnOperation(msg){
		// var msgStore = msgStorage.getStore();
		if (!msg.playerid) { // learn only from the player, not other's messages
			sendNote("Tokens can only learn from a player");
			return;
		}
		if (!msg.selected) {
			sendNote("No token selected", msg);
			return;
		}
		// fall through
		_.each(msg.selected, function(sel) { // selections appear to be some truncated rep of graphics
			var wtok = pwTokens.getPWToken(sel._id);
			var learnerName = wtok.get('name') + "-token-";
			var playerLastMsg = msgLog.retreive(msg.playerid);
			if(! playerLastMsg )
				sendNote("Do something first, then I can learn to mimic it.", msg, learnerName);
			else {
				wtok.set('learned', acousticAdjust(playerLastMsg));
				wtok.set('autoBarDec', cBarNumber );
				sendNote("I am learning from " + msg.who,  msg, learnerName); // getObj('player', msg.playerid).get("_displayname"),
			}
		});
	};
	
	function autoBarDecrement(wtok, barOverride){
		// work with the wrapped token to decrement the appropritae bar, per ammo
		var barNum = barOverride || wtok.get('autoBarDec');
		if(!barNum) return null;
		var barPropName = "bar" + barNum + "_value";
		var ammoVal = parseInt(wtok.get(barPropName));
		if( _.isNaN(ammoVal)) ammoVal = 0;
		wtok.set(barPropName, ammoVal -1);
		return ammoVal -1;
	}

	function performOperation(msg){
		// var msgStore = msgStorage.getStore();
		if (!msg.selected) {
			sendNote("No token selected", msg);
			return;
		}
		_.each(msg.selected, function(sel) {
			var wtok = pwTokens.getPWToken(sel._id);
			var performerName = wtok.get('name') + "-token-";
			var learned = wtok.get('learned');
			if (learned){
				sendChat(performerName, edMsgUtils.Revert(acousticAdjust(learned)));
				autoBarDecrement(wtok, cBarNumber);
			}
			else
				sendNote("I have not learned what performance to mimic", msg, performerName);
		});
	};

	function dumpOperation(msg){ // for debugging
		// check for gm here
		if(!playerIsGM(msg.playerid)){
			sendNote("dump operation is GM priviledged", msg);
			return ;
		}
		log(pwTokens.data());
	};

	function resetOperation(msg){
		if(!playerIsGM(msg.playerid)){
			sendNote("reset operation is GM priviledged", msg);
			return ;
		}
		pwTokens.reset();
		sendNote("Tokens now forget what they learned.", msg);
	}

	function cleanOperation(msg){
		if(!playerIsGM(msg.playerid)){
			sendNote("clean operation is GM priviledged", msg);
			return ;
		}
		pwTokens.clean();
		sendNote("Deleted token memory clean-up finished.", msg);
	};

	function buttonsOperation(msg){
		if(!playerIsGM(msg.playerid)){
			sendNote("buttons operation is GM priviledged", msg);
			return ;
		}
		var domacro = function(attrs){
			var found = findObjs({ _type: "macro", name: attrs.name });
			if( found && found.length > 0 ) return attrs.name + " macro already exists";
			if(!createObj("macro", attrs )) return attrs.name + " macro not created";
			return attrs.name + " macro created";

		};
		sendNote( domacro({ _playerid : msg.playerid, name : "[Learn]", 
			action : "!mimic -learn", visibleto: "", istokenaction : true }), msg);
		sendNote( domacro({ _playerid : msg.playerid, name : "[Perform]", 
			action : "!mimic -perform", visibleto: "", istokenaction : true }), msg);
	}

	// END OF script input commands

	var registerEventHandlers = function() {
		pwTokens.clean(); // should be on sandbox spinup, not needed for each player.
		on('chat:message', handleMsgInput);
		log("!mimic: chat handler installed");
	};

	return {
		// CheckInstall: checkInstall,
		RegisterEventHandlers: registerEventHandlers,

	};

}());

on('ready',function() {
	// 'use strict';

	//mimicModule.CheckInstall();
	mimicModule.RegisterEventHandlers();
});

