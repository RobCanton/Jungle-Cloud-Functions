const notification_text_max_length = 32;

exports.haversineDistance = function(lat1, lon1, lat2, lon2) {
  var p = 0.017453292519943295;    // Math.PI / 180
  var c = Math.cos;
  var a = 0.5 - c((lat2 - lat1) * p)/2 + 
          c(lat1 * p) * c(lat2 * p) * 
          (1 - c((lon2 - lon1) * p))/2;

  return 12742 * Math.asin(Math.sqrt(a)); // 2 * R; R = 6371 km
}

exports.getMinutesSinceNow = function(_date) {
  var date = new Date(_date);
  var now = new Date();
  var diff = now.getTime() - date.getTime();
  return Math.round(diff / 60000);
}

exports.trimTextForNotification = function(text) {
    var string = text;
    var trimmedString = null;
    if (string !== null && string !== undefined) {
        trimmedString = string.length > notification_text_max_length ?
            string.substring(0, notification_text_max_length - 3) + "..." : string;
    }
    return trimmedString;
}

exports.extractMentions = function(text) {
    const pattern = /\B@[a-z0-9_-]+/gi;
    let results = text.match(pattern);

    return results != null ? results : [];
}

exports.calculateUserStoryPopularityScore = function(numPosts, numViews, numParticipants) {
    return numPosts + numViews * 2.0 + numParticipants * 3.0
}

exports.calculatePlaceStoryPopularityScore = function(numPosts, numViews, numParticipants) {
    return numPosts * 2.0 + numViews * 2.0 + numParticipants * 3.0
}