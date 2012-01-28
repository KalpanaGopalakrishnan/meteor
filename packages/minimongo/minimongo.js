// XXX indexes
// XXX type checking on selectors (graceful error if malformed)
// XXX merge ad-hoc live query object and Query

// XXX keep observe()s running after they're killed, because usually
// the dependency tracker is going to spin them up again right away.

// Collection: a set of documents that supports queries and modifiers.

// Query: a specification for a particular subset of documents, w/
// a defined order, limit, and offset.  creating a Query with Collection.find(),

// LiveResultsSet: the return value of a live query.

Collection = function () {
  this.docs = {}; // _id -> document (also containing id)

  this.next_qid = 1; // live query id generator

  // qid -> live query object. keys: selector_f, sort_f, (callbacks)
  this.queries = {};
};

// options may include sort, skip, limit, reactive
// sort may be any of these forms:
//     {a: 1, b: -1}
//     [["a", "asc"], ["b", "desc"]]
//     ["a", ["b", "desc"]]
//   (in the first form you're beholden to key enumeration order in
//   your javascript VM)
//
// reactive: if given, and false, don't register with Meteor.deps (default
// is true)
//
// XXX possibly should support retrieving a subset of fields? and
// have it be a hint (ignored on the client, when not copying the
// doc?)
//
// XXX sort does not yet support subkeys ('a.b') .. fix that!
// XXX add one more sort form: "key"
// XXX tests
Collection.prototype.find = function (selector, options) {
  return new Collection.Query(this, selector, options);
};

// don't call this ctor directly.  use Collection.find().
Collection.Query = function (collection, selector, options) {
  if (!options) options = {};

  this.collection = collection;

  if (typeof selector === "string") {
    // stash for fast path
    this.selector_id = selector;
    this.selector_f = Collection._compileSelector({_id: selector});
  } else {
    this.selector_f = Collection._compileSelector(selector);
    this.sort_f = options.sort ? Collection._compileSort(options.sort) : null;
    this.skip = options.skip;
    this.limit = options.limit;
  }

  this.db_objects = null;
  this.cursor_pos = 0;

  // by default, queries register w/ Meteor.deps when it is available.
  if (typeof Meteor === "object" && Meteor.deps)
    this.reactive = (options.reactive === undefined) ? true : options.reactive;
};

// fetch array of documents from the cursor.  defaults to all
// remaining docs, or limited to specified length.  returns [] once
// all documents have been consumed.
Collection.Query.prototype.fetch = function (length) {
  var self = this;

  if (self.reactive)
    self._markAsReactive({added: true,
                          removed: true,
                          changed: true,
                          moved: true});

  if (self.db_objects === null)
    self.db_objects = self._getRawObjects();

  var idx_end = length ? (length + self.cursor_pos) : self.db_objects.length;
  var objects = self.db_objects.slice(self.cursor_pos, idx_end);
  self.cursor_pos += objects.length;

  var results = [];
  for (var i = 0; i < objects.length; i++)
    results.push(Collection._deepcopy(objects[i]));
  return results;
};

Collection.Query.prototype.rewind = function () {
  var self = this;
  self.db_objects = null;
  self.cursor_pos = 0;
};

Collection.Query.prototype.get = function (offset) {
  var self = this;
  offset = offset || 0;
  return self.fetch(offset + 1).pop();
};

Collection.prototype.findOne = function (selector, options) {
  return this.find(selector, options).get();
};

Collection.STOP = 'stop';
Collection.Query.prototype.forEach = function (callback) {
  var self = this;
  var doc;

  while ((doc = self.get()))
    if (callback(doc) === Collection.STOP)
      // callback requests we break out of forEach
      return;
};

Collection.Query.prototype.map = function (callback) {
  var self = this;
  var res = [];
  var doc;

  while ((doc = self.get()))
    res.push(callback(doc));
  return res;
};

Collection.Query.prototype.count = function () {
  var self = this;

  if (self.reactive)
    self._markAsReactive({added: true, removed: true});

  if (self.db_objects === null)
    self.db_objects = self._getRawObjects();

  return self.db_objects.length;
};

// the handle that comes back from observe.
Collection.LiveResultsSet = function () {};

Collection.Query.prototype.observe = function (options) {
  var self = this;

  if (self.skip || self.limit)
    throw new Error("cannot observe queries with skip or limit");

  var qid = self.collection.next_qid++;

  // XXX merge this object w/ "this" Query.  they're the same.
  var query = self.collection.queries[qid] = {
    selector_f: self.selector_f, // not fast pathed
    sort_f: self.sort_f,
    results: []
  };
  query.results = self._getRawObjects();

  query.added = options.added || function () {};
  query.changed = options.changed || function () {};
  query.moved = options.moved || function () {};
  query.removed = options.removed || function () {};
  if (!options._suppress_initial)
    for (var i = 0; i < query.results.length; i++)
      query.added(Collection._deepcopy(query.results[i]), i);

  var handle = new Collection.LiveResultsSet;
  _.extend(handle, {
    stop: function () {
      delete self.collection.queries[qid];
    },
    indexOf: function (id) {
      for (var i = 0; i < query.results.length; i++)
        if (query.results[i]._id === id)
          return i;
      return -1;
    },
    collection: self.collection
  });
  return handle;
};

// constructs sorted array of matching objects, but doesn't copy them.
// respects sort, skip, and limit properties of the query.
// if sort_f is falsey, no sort -- you get the natural order
Collection.Query.prototype._getRawObjects = function () {
  var self = this;

  // fast path for single ID value
  if (self.selector_id)
    return [self.collection.docs[self.selector_id]];

  // slow path for arbitrary selector, sort, skip, limit
  var results = [];
  for (var id in self.collection.docs) {
    var doc = self.collection.docs[id];
    if (self.selector_f(doc))
      results.push(doc);
  }

  if (self.sort_f)
    results.sort(self.sort_f);

  var idx_start = self.skip || 0;
  var idx_end = self.limit ? (self.limit + idx_start) : results.length;
  return results.slice(idx_start, idx_end);
};

Collection.Query.prototype._markAsReactive = function (options) {
  var self = this;

  var context = Meteor.deps.Context.current;

  if (context) {
    var invalidate = _.bind(context.invalidate, context);

    var handle = self.observe({added: options.added && invalidate,
                               removed: options.removed && invalidate,
                               changed: options.changed && invalidate,
                               moved: options.moved && invalidate,
                               _suppress_initial: true});

    // XXX in many cases, the query will be immediately
    // recreated. so we might want to let it linger for a little
    // while and repurpose it if it comes back. this will save us
    // work because we won't have to redo the initial find.
    context.on_invalidate(handle.stop);
  }
};

// XXX enforce rule that field names can't start with '$' or contain '.'
// (real mongodb does in fact enforce this)
// XXX possibly enforce that 'undefined' does not appear (we assume
// this in our handling of null and $exists)
Collection.prototype.insert = function (doc) {
  var self = this;
  doc = Collection._deepcopy(doc);
  // XXX deal with mongo's binary id type?
  if (!('_id' in doc))
    doc._id = Collection.uuid();
  // XXX check to see that there is no object with this _id yet?
  self.docs[doc._id] = doc;

  // trigger live queries that match
  for (var qid in self.queries) {
    var query = self.queries[qid];
    if (query.selector_f(doc))
      Collection._insertInResults(query, doc);
  }
};

// options to contain:
//  * callbacks:
//    - added (object, before_index)
//    - changed (new_object, at_index)
//    - moved (object, old_index, new_index) - can only fire with changed()
//    - removed (id, at_index)
//  * sort: sort descriptor
//
// attributes available on returned query handle:
//  * stop(): end updates
//  * indexOf(id): return current index of object in result set, or -1
//  * collection: the collection this query is querying
//
// iff x is a returned query handle, (x instanceof
// Collection.LiveResultsSet) is true
//
// initial results delivered through added callback
// XXX maybe callbacks should take a list of objects, to expose transactions?
// XXX maybe support field limiting (to limit what you're notified on)
// XXX maybe support limit/skip
// XXX it'd be helpful if removed got the object that just left the
// query, not just its id
// XXX document that initial results will definitely be delivered before we return [do, add to asana]

Collection.prototype.remove = function (selector) {
  var self = this;
  var remove = [];
  var query_remove = [];
  if (typeof(selector) === "string")
    selector = {_id: selector};
  var selector_f = Collection._compileSelector(selector);
  for (var id in self.docs) {
    var doc = self.docs[id];
    if (selector_f(doc)) {
      remove.push(id);
      for (var qid in self.queries) {
        var query = self.queries[qid];
        if (query.selector_f(doc))
          query_remove.push([query, doc]);
      }
    }
  }
  for (var i = 0; i < remove.length; i++) {
    delete self.docs[remove[i]];
  }

  // run live query callbacks _after_ we've removed the documents.
  for (var i = 0; i < query_remove.length; i++) {
    Collection._removeFromResults(query_remove[i][0], query_remove[i][1]);
  }
};

// XXX atomicity: if multi is true, and one modification fails, do
// we rollback the whole operation, or what?
Collection.prototype.update = function (selector, mod, options) {
  if (typeof(selector) === "string")
    selector = {_id: selector};

  if (!options) options = {};
  // Default to multi. This is the oppposite of mongo. We'll see how it goes.
  if (typeof(options.multi) === "undefined")
    options.multi = true

  var self = this;
  var any = false;
  var selector_f = Collection._compileSelector(selector);
  for (var id in self.docs) {
    var doc = self.docs[id];
    if (selector_f(doc)) {
      self._modifyAndNotify(doc, mod);
      if (!options.multi)
        return;
      any = true;
    }
  }

  if (options.upsert) {
    throw Error("upsert not yet implemented");
  }

  if (options.upsert && !any) {
    // XXX is this actually right? don't we have to resolve/delete
    // $-ops or something like that?
    insert = Collection._deepcopy(selector);
    Collection._modify(insert, mod);
    self.insert(insert);
  }
};

Collection.prototype._modifyAndNotify = function (doc, mod) {
  var self = this;

  var matched_before = {};
  for (var qid in self.queries)
    matched_before[qid] = self.queries[qid].selector_f(doc);

  Collection._modify(doc, mod);

  for (var qid in self.queries) {
    var query = self.queries[qid];
    var before = matched_before[qid];
    var after = query.selector_f(doc);
    if (before && !after)
      Collection._removeFromResults(query, doc);
    else if (!before && after)
      Collection._insertInResults(query, doc);
    else if (before && after)
      Collection._updateInResults(query, doc);
  }
};

// XXX findandmodify

Collection._deepcopy = function (v) {
  if (typeof(v) !== "object")
    return v;
  if (v === null)
    return null; // null has typeof "object"
  if (_.isArray(v)) {
    var ret = v.slice(0);
    for (var i = 0; i < v.length; i++)
      ret[i] = Collection._deepcopy(ret[i]);
    return ret;
  }
  var ret = {};
  for (var key in v)
    ret[key] = Collection._deepcopy(v[key]);
  return ret;
};

// XXX the sorted-query logic below is laughably inefficient. we'll
// need to come up with a better datastructure for this.

Collection._insertInResults = function (query, doc) {
  if (!query.sort_f) {
    query.added(doc, query.results.length);
    query.results.push(doc);
  } else {
    var i = Collection._insertInSortedList(query.sort_f, query.results, doc);
    query.added(doc, i);
  }
};

Collection._removeFromResults = function (query, doc) {
  var i = Collection._findInResults(query, doc);
  query.removed(doc._id, i);
  query.results.splice(i, 1);
};

Collection._updateInResults = function (query, doc) {
  var orig_idx = Collection._findInResults(query, doc);
  query.changed(Collection._deepcopy(doc), orig_idx);

  if (!query.sort_f)
    return;

  // just take it out and put it back in again, and see if the index
  // changes
  query.results.splice(orig_idx, 1);
  var new_idx = Collection._insertInSortedList(query.sort_f,
                                               query.results, doc);
  if (orig_idx !== new_idx)
    query.moved(doc, orig_idx, new_idx);
};

Collection._findInResults = function (query, doc) {
  for (var i = 0; i < query.results.length; i++)
    if (query.results[i] === doc)
      return i;
  throw Error("object missing from query");
};

Collection._insertInSortedList = function (cmp, array, value) {
  if (array.length === 0) {
    array.push(value);
    return 0;
  }

  for (var i = 0; i < array.length; i++) {
    if (cmp(value, array[i]) < 0) {
      array.splice(i, 0, value);
      return i;
    }
  }

  array.push(value);
  return array.length - 1;
};
