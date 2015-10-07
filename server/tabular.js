/* global check, Match, Meteor, tablesByName, _ */

/*
 * These are the two publications used by TabularTable.
 *
 * The genericPub one can be overridden by supplying a `pub`
 * property with a different publication name. This publication
 * is given only the list of ids and requested fields. You may
 * want to override it if you need to publish documents from
 * related collections along with the table collection documents.
 *
 * The getInfo one runs first and handles all the complex logic
 * required by this package, so that you don't have to duplicate
 * this logic when overriding the genericPub function.
 *
 * Having two publications also allows fine-grained control of
 * reactivity on the client.
 */

Meteor.publish("tabular_genericPub", function (tableName, ids, fields) {
  var self = this;

  check(tableName, String);
  check(ids, Array);
  check(fields, Match.Optional(Object));

  var table = tablesByName[tableName];
  if (!table) {
    // We throw an error in the other pub, so no need to throw one here
    self.ready();
    return;
  }

  // Extend fields list with extra fields from the table definition
  if (table.extraFields) {
    _.extend(fields, table.extraFields);
  }

  // Check security. We call this in both publications.
  if (typeof table.allow === 'function' && !table.allow(self.userId, fields)) {
    self.ready();
    return;
  }

  // Check security for fields. We call this only in this publication
  if (typeof table.allowFields === 'function' && !table.allowFields(self.userId, fields)) {
    self.ready();
    return;
  }

  return table.collection.find({_id: {$in: ids}}, {fields: fields});
});

Meteor.publish("tabular_getInfo", function(tableName, selector, sort, skip, limit) {
  var self = this,
		userId = this.userId;
	
  check(tableName, String);
  check(selector, Match.Optional(Match.OneOf(Object, null)));
  check(sort, Match.Optional(Match.OneOf(Array, null)));
  check(skip, Number);
  check(limit, Number);

  var table = tablesByName[tableName];
  if (!table) {
    throw new Error('No TabularTable defined with the name "' + tableName + '". Make sure you are defining your TabularTable in common code.');
  }

  // Verify that limit is not 0, because that will actually
  // publish all document _ids.
  if (limit === 0) {
    limit = 1;
  }

  // Check security. We call this in both publications.
  // Even though we're only publishing _ids and counts
  // from this function, with sensitive data, there is
  // a chance someone could do a query and learn something
  // just based on whether a result is found or not.
  if (typeof table.allow === 'function' && !table.allow(self.userId)) {
    self.ready();
    return;
  }

	//selector == SELECTOR FROM CLIENT
  selector = selector || {};

  // Allow the user to modify the selector before we use it
  if (typeof table.changeSelector === 'function') {
    selector = table.changeSelector(selector, self.userId);
  }

  // Apply the server side selector specified in the tabular
  // table constructor. Both must be met, so we join
  // them using $and, allowing both selectors to have
  // the same keys.
	
	//table.selector == SELECTOR FROM SERVER
  if(table.selector) {
    var tableSelector = _.isFunction(table.selector) ? table.selector(self.userId) : table.selector;
		tableSelector = tableSelector || {};
		
		if(_.isEmpty(selector)) selector = tableSelector;
		else if(_.isEmpty(tableSelector)) selector = selector;
		else selector = {$and: [tableSelector, selector]};
  }

  var findOptions = {
    skip: skip,
    limit: limit,
    fields: {_id: 1}
  };

  // `sort` may be `null`
  if (_.isArray(sort)) {
    findOptions.sort = sort;
  }

  var filteredCursor = table.collection.find(selector, findOptions);

  var filteredRecordIds = filteredCursor.map(function (doc) {
    return doc._id;
  });

  

  var recordReady = false;
	
  var updateRecords = function() {
		var countCursor = table.collection.find(selector, {fields: {_id: 1}});
    var currentCount = countCursor.count();

    var record = {
      ids: filteredRecordIds,
      // count() will give us the updated total count
      // every time. It does not take the find options
      // limit into account.
      recordsTotal: currentCount,
      recordsFiltered: currentCount
    };

    if (recordReady) {
      //console.log("changed", tableName, record);
      self.changed('tabular_records', tableName, record);
    } else {
      //console.log("added", tableName, record);
      self.added("tabular_records", tableName, record);
      recordReady = true;
    }
  }


	//added by Ultimate MVC Team (can't have the db and network hit like crazy)
	var throttle = function(fn, threshhold, scope) {
	  threshhold || (threshhold = 250);
	  var last, deferTimer;
		
	  return function () {
	    var context = scope || this,
				now = +new Date, 
				args = arguments;
				
	    if (last && now < last + threshhold) {
	      clearTimeout(deferTimer);
				
	      deferTimer = Meteor.setTimeout(function () {
	        last = now;
	        fn.apply(context, args);
	      }, threshhold);
				
	    } 
			else {
	      last = now;
	      fn.apply(context, args);
	    }
	  };
	}
	
	updateRecords = throttle(updateRecords, 500);
	
	var handle1, handle2, removalHandle, userObserver;
	
	function observe() {
	  // Handle docs being added or removed from the result set.
	  var initializing1 = true;
	  handle1 = filteredCursor.observeChanges({
	    added: function (id) {
	      if(initializing1) return;

	      filteredRecordIds.push(id);
	      updateRecords();
	    },
	    removed: function (id) {
	      //console.log("REMOVED");
	      filteredRecordIds = _.without(filteredRecordIds, id);
	      updateRecords();
	    }
	  });
	  initializing1 = false;

	  // Handle docs being added or removed from the non-limited set.
	  // This allows us to get total count available.
	  var initializing2 = true;
		/** CAN'T USE THIS ANYMORE SINCE IT'S TOO SLOW ON BIG TABLES -- WE USE UPDATED_AT ON CURRENT TABLE /W LIMIT 1
		//PLUS ULTIMATE REMOVALS /W LIMIT 1 INSTEAD -james gillmore (Ultimate MVC Team)
	
	  var handle2 = countCursor.observeChanges({
	    added: function () {
	      if(!initializing2) updateRecords();
	    },
	    removed: function () {
	      updateRecords();
	    }
	  });
		**/
	

		var collectionCursor = table.collection.find(selector, {limit: 1, sort: {updated_at: -1}, fields: {_id: 1}});
	
		handle2 = collectionCursor.observeChanges({
		  added: function () {
		    if(!initializing2)  updateRecords();
		  }
		});

		var removalSelector = selector ? _.clone(selector) : {};
	
		removalSelector.collection = table.collection._name; 
		if(removalSelector.className) removalSelector.oldClassName = selector.className;
	
		if(removalSelector.created_at) removalSelector.oldCreated_at = removalSelector.created_at;
		if(removalSelector.updated_at) removalSelector.oldUpdated_at = removalSelector.updated_at;
	
		delete removalSelector.className; //do this because they will end up with className == 'UltimateRemoval'
		delete removalSelector.created_at;
		delete removalSelector.updated_at;
	
		var removalCursor = UltimateRemovals.find(removalSelector, {limit: 1, sort: {updated_at: -1}});
		
	  removalHandle = removalCursor.observeChanges({
	    added: function () {
	      if(!initializing2)  updateRecords();
	    }
	  });
	
	  initializing2 = false;
	}
  
	observe();
  updateRecords();
  self.ready();

  // Stop observing the cursors when client unsubs.
  // Stopping a subscription automatically takes
  // care of sending the client any removed messages.
	function stopObservers() {
    handle1.stop();
    handle2.stop();
		removalHandle.stop();
	}
	
  self.onStop(function() {
		stopObservers();
  	if(userObserver) userObserver.stop();
  });
	
	
	
	function handleUserChange() {
		userObserver = Meteor.users.find(userId).observe({
			changed: function(newUserDoc, oldUserDoc) { 
				var subName = table.observeUser.subName,
					ModelClass = table.observeUser.class,
					config = ModelClass.prototype.subscriptions[subName].call(ModelClass.prototype, userId);
				
				if(config.hasOwnProperty('selector') && !_.isEqual(config.selector, selector)) {
					selector = config.selector;
					
					filteredCursor = table.collection.find(selector, findOptions);

				  filteredRecordIds = filteredCursor.map(function (doc) {
				    return doc._id;
				  });
					
					console.log('SELECTOR NOT SAME', config);
					
					stopObservers();
					observe();
				  updateRecords();
				}
			}.bind(this)
		});
	}
	
	if(table.observeUser) handleUserChange();
});
