/****

mimic - a roll20.net api script to teach any selected token to reproduce any player chat message.
version: 0.2 alpha May 15 2015
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
    *-clean recover state space by forgetting actions of deleted tokens. GM only.
opts are:
    ***-n where n is a single digit 0-9. Use token's nth of 10 action memories. Default is memory 0.
    *-whisper force the token to whisper to the gm. also whisper script notifications to gm.
              useful to test a token's command memory without alerting players.
    *-shout force the token to NOT whisper. Useful when the token was taught by whisper-ing.
    -quiet suppress all chat notification of script activity

*** == NOT YET IMPLEMENTED
* === NOT YET TESTED

Coding strategy:
  1. last player msg stores in state assoc
  2. selected token learns message by copying players last messg to state assoc
  3. selected token finds its learned message in state assoc

KNOWN ISSUES:
// whisper only goes to GM from apis. Can't whisper to players
// token prevented from learing api calls. Prevents cascade failures 
           in learning/performing cycles
//         also prevents strange api interaction.
// mimic gets confused by some obscure chat sequences, but apparently keeps on truckin'.
// not sure the way I'm applying template is comprehensive. I only do D&D 5e and that works. What about powercard, etc?
// Tried attaching directly to objects instead of using state, but data would
not persist. Need to consider re-write switching back to object approach by 
wrapping the token objects with a generalized state object. Then we could really enhance tokens!
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

// Next Ed.B. project: ammo tracker that gloms onto attack rolls. looks like a few 
similar ammo scripts out there. Maybe I can hack them to suit.
*****/

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
		// return ""; // fix this code
		switch (msg.type) {
		case "rollresult":
			return "/roll "; // reproduce /r /roll
		case "gmrollresult":
			return "/gmroll "; // reproduce /gmroll
		case "emote":
			return "/em "; // reproduce /emote
			// case "whisper": return "/w \"" + msg.target_name + "\" "; // reproduce /w
		case "whisper":
			return "/w GM "; // until whisper to characters is available
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
	// (4) whispers to player don't work on the server side api as of May 10 2015
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
	
	function acousticAdjust(msg){ //note _.clone is shallow
		if(! msg ) return null;
		if( cWhisperFlag ) return edMsgUtils.toWhisper(_.clone(msg));
		if( cShoutFlag ) return edMsgUtils.toShout(_.clone(msg));
		return msg;	
	}	
	
	//	enforce persistent data as a singleton member of state	
	var msgStorage = (function(){
		function getStorage(key){ //	should have better check here for "not an object" test
			if (!state.hasOwnProperty("mimicMsgStore"))	state.mimicMsgStore = {};
			//if (Array.isArray(state.mimicMsgStore)) {
			//	log("!mimic: converting from array");
			//	state.mimicMsgStore = {};
			//}
			if(!key) return state.mimicMsgStore;
			return state.mimicMsgStore[key] || null;
		};
		function setStorage(key,val){
			getStorage(); // make sure it exists
			var oldval = state.mimicMsgStore[key] || null;
			state.mimicMsgStore[key] = value;
			return oldval;
		};
		function resetStorage(){
			state.mimicMsgStore = {};
		};
		function cleanStorage(){ // delete keys that aren't roll20 objids
			getStorage();
			for (var objid in state.mimicMsgStore) {
			    if (state.mimicMsgStore.hasOwnProperty(objid))
			    	if(!getObj('graphic',objid) && !getObj('player',objid))
			    		if(! delete state.mimicMsgStore[objid] )
			    			log("!mimic script: JS delete failed in msgStorage.cleanStorage");
			}
		};
		return {
			getStore : getStorage, // note to programmer: use getter/setter for this.
			setStore : setStorage,
			clean : cleanStorage,
			reset : resetStorage
		};
	})();

	var sendNotice = function(whofrom, noticeString, whoto) {
		// can't whisper to players form api as of May 2015, so unfortunately whoto doesn't work
		// change to whisper to who when available.
		if( cQuietFlag ) return;
		var prefix = "";
		if( cWhisperFlag ) prefix = "/w GM "; // only working whisper is GM
		// upgrade when whisper available: 	if whoto, override cWhisperFlag with  prefix = "/w " + whoto
		//          						if cShoutFlag, override whoto
		whofrom = whofrom || "Mimic script" ;
		sendChat(whofrom, prefix + noticeString);
	};

	var handleMsgInput = function(msg) {
		
		var msgStore = msgStorage.getStore();
		
		// if this is a player's message, put it in storage for later mimicing.
		// Could put this in a separate handler from !mimic.
		// No apis allowed prevents cascade failures. (this may be overly cautious.)	
		if (msg.type !== "api" && 'playerid' in msg && msg.content.indexOf("!mimic") === -1) {
			msgStore[msg.playerid] = msg; // not cloning it seems to persist OK.
			return; // only !mimic needs to make it further
		}

		if (msg.type !== "api" || msg.content.indexOf("!mimic") === -1) return;
		// fall through must be !mimic - parse the opts	

		var opFunc = performOperation; // reset defaults
		cQuietFlag = false;
		cWhisperFlag = false;
		cShoutFlag = false;	
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
		  default:
              operationCount++;
			  opFunc = function(){ sendNotice("", "Unknown operation or command"); };
		  }
		
		if(operationCount > 1){
			sendNotice("","too many command options given.");
			return ;
		}		
        opFunc(msg);    
	};
   
	function learnOperation(msg){
		var msgStore = msgStorage.getStore();
		if (!msg.playerid) { // learn only from the player, not other's messages
			sendNotice("", "Tokens can only learn from a player");
			return;
		}
		if (!msg.selected) {
			sendNotice("", "No token selected");
			return;
		}
		// fall through
		_.each(msg.selected, function(tok) {
			var learnerName = (getObj(tok._type, tok._id).get('name') + "-token-");
			var playerLastMsg = msgStore[msg.playerid] || null;
			if(! playerLastMsg )
				sendNotice(learnerName, "Do something first, then I can learn to mimic it.");
			else {
				msgStore[tok._id] = acousticAdjust(playerLastMsg);
				sendNotice(learnerName,
						"I am learning from " + getObj('player', msg.playerid).get("_displayname"));
			}
		});
	};
    
    function performOperation(msg){
		var msgStore = msgStorage.getStore();
		if (!msg.selected) {
			sendNotice(msg.who, "No token selected", msg.who);
			return;
		}
    	_.each(msg.selected, function(tok) {
			var performerName = (getObj(tok._type, tok._id).get('name') + "-token-");
			if (msgStore[tok._id])
				sendChat(performerName, edMsgUtils.Revert(acousticAdjust(msgStore[tok._id])));
			else
				sendNotice(performerName, "I have not learned what performance to mimic");
		});
    };
    
    function dumpOperation(msg){ // for debugging
    	// check for gm here
    	if(!playerIsGM(msg.playerid)){
    		sendNotice("", "dump operation is GM priviledged");
    		return ;
    	}
		log(msgStorage.getStore());
    };
    
    function resetOperation(){
    	if(!playerIsGM(msg.playerid)){
    		sendNotice("", "reset operation is GM priviledged");
    		return ;
    	}
    	msgStorage.reset();
    	sendNotice("", "Tokens now forget what they learned.");
    }

    function cleanOperation(){
    	if(!playerIsGM(msg.playerid)){
    		sendNotice("", "clean operation is GM priviledged");
    		return ;
    	}
    	msgStorage.clean();
    	sendNotice("", "Deleted token memory clean-up finished.");
    };
    
    function buttonsOperation(msg){
    	if(!playerIsGM(msg.playerid)){
    		sendNotice("", "buttons operation is GM priviledged");
    		return ;
    	}
    	var domacro = function(attrs){
    		var found = findObjs({ _type: "macro", name: attrs.name });
    		if( found && found.length > 0 ) return attrs.name + " macro already exists";
    		if(!createObj("macro", attrs )) return attrs.name + " macro not created";
    		return attrs.name + " macro created";

    	};
    	sendNotice( "", domacro({ _playerid : msg.playerid, name : "[Learn]", 
    		action : "!mimic -learn", visibleto: "", istokenaction : true }));
    	sendNotice( "", domacro({ _playerid : msg.playerid, name : "[Perform]", 
    		action : "!mimic -perform", visibleto: "", istokenaction : true }));
    }
    
    // END OF script input commands
    
	var registerEventHandlers = function() {
		msgStorage.clean(); // should be on sandbox spinup, not needed for each player.
		on('chat:message', handleMsgInput);
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

