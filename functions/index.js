const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp(functions.config().firebase);

const database = admin.database();

/**
 * Triggers when a user gets a new follower and sends a notification.
 *
 * Followers add a flag to `/followers/{followedUid}/{followerUid}`.
 * Users save their device notification tokens to `/users/{followedUid}/notificationTokens/{notificationToken}`.
 */
exports.sendFollowerNotification = functions.database.ref('/users/social/followers/{followedUid}/{followerUid}').onWrite(event => {
    const followerUid = event.params.followerUid;
    const followedUid = event.params.followedUid;
    const value = event.data.val();

    var toRemove = false;
    if (value == null) {
        toRemove = true;
    }

    const followedStoryRef = database.ref('/users/story/' + followedUid);

    return followedStoryRef.once('value').then(snapshot => {
        if (snapshot.exists()) {
            const followerFeedRef = database.ref('/users/feed/following/' + followerUid + '/' + followedUid + '/');
            if (toRemove) {
                return followerFeedRef.remove();
            }
            return followerFeedRef.set(snapshot.val());
        }
    });

    //return createFollowNotification(followerUid, followedUid);

});

function createFollowNotification(sender, recipient) {
    if (sender === recipient) {
        return
    }

    let notificationObject = {};

    // Custom key pattern so that all follow notifications are user -> user specific
    let nKey = "follow:" + sender;

    notificationObject["notifications/" + nKey] = {
        "type": 'FOLLOW',
        "sender": sender,
        "recipient": recipient,
        "timestamp": admin.database.ServerValue.TIMESTAMP
    }
    notificationObject["users/notifications/" + recipient + "/" + nKey] = false;

    // Do a deep-path update
    return database.ref().update(notificationObject, function (error) {
        if (error) {
            console.log("Error updating data:", error);
        }
    });
};

exports.sendMessageNotification =
    functions.database.ref('/conversations/{conversationKey}/messages/{messageKey}').onWrite(event => {
        const conversationKey = event.params.conversationKey;
        const messageKey = event.params.messageKey;

        console.log("Message: ", messageKey, " -> Conversation: ", conversationKey);
    });

exports.processUploads =
    functions.database.ref('/uploads/data/{uploadKey}/meta').onWrite(event => {
        const uploadKey = event.params.uploadKey;
        const value = event.data.val();
        const newData = event.data._newData;
        const prevData = event.data.previous._data;

        console.log('upload: ', uploadKey, 'onWrite.');

        if (value == null) {
            return deletePost(uploadKey, prevData.author, prevData.placeID);
        }

        const author = newData.author;
        const dateCreated = newData.dateCreated;

        const followersRef = database.ref("users/social/followers/" + author);

        return followersRef.once('value').then(snapshot => {
            if (snapshot.exists()) {

                snapshot.forEach(function (follower) {
                    const followerUid = follower.key;
                    console.log("Follower: ", followerUid);

                    const tempRef = database.ref("users/social/stories/" + followerUid + '/' + author + '/' + uploadKey);
                    tempRef.set(dateCreated);

                });
            }
        });
    });

function deletePost(key, author, placeId) {
    console.log("Delete post: ", key);

    database.ref('places/' + placeId + '/posts/' + key).remove();
    database.ref('users/story/' + author + '/' + key).remove();
    database.ref('users/uploads/' + author + '/' + key).remove();

    const postNotifications = database.ref('uploads/notifications/' + key);

    return postNotifications.once('value').then(snapshot => {
        snapshot.forEach(function (notificationPair) {
            const notificationKey = notificationPair.key;
            const recipient = notificationPair.val();
            database.ref('notifications/' + notificationKey).remove();
        });
    });
}

exports.processNotifications = functions.database.ref('/notifications/{notificationKey}').onWrite(event => {
    const notificationKey = event.params.notificationKey;
    const value = event.data.val();
    const prevData = event.data.previous._data;

    if (value == null && prevData !== null) {
        const postKey = prevData.postKey;
        const recipient = prevData.recipient;
        database.ref('users/notifications/' + recipient + '/' + notificationKey).remove();
        database.ref('uploads/notifications/' + postKey + '/' + notificationKey).remove();
        return console.log('Notification deleted: ', notificationKey);
    }

    return;
});

exports.sendCommentNotification = functions.database.ref('/uploads/data/{postKey}/comments/{commentKey}').onWrite(event => {
    const postKey = event.params.postKey;
    const commentKey = event.params.commentKey;
    const value = event.data.val();
    const newData = event.data._newData;

    if (value == null) {
        return console.log('Comment deleted: ', commentKey);
    }

    return console.log('Send comment notification.');
});


exports.locationUpdate = functions.database.ref('/users/location/coordinates/{uid}').onWrite(event => {
    const userId = event.params.uid;
    const value = event.data.val();
    const newData = event.data._newData;

    const lat = newData.lat;
    const lon = newData.lon;
    const rad = newData.rad;

    if (value == null) {
        return console.log('Location removed: ', userId);
    }

    const placesRef = database.ref('places');

    var nearbyPlaceIds = {};

    return placesRef.once('value').then(snapshot => {
        snapshot.forEach(function (place) {
            const id = place.key;
            const name = place.val().name;
            const place_lat = place.val().info.lat;
            const place_lon = place.val().info.lon;
            //const posts = place.val().posts;
            var distance = haversineDistance(lat, lon, place_lat, place_lon);
            if (distance <= rad) {
                nearbyPlaceIds[id] = distance;
            }
        });
        database.ref('users/location/nearby/' + userId + '/').set(nearbyPlaceIds);
    });
});

exports.nearbyStoriesUpdate =
    functions.database.ref('/users/location/nearby/{uid}').onWrite(event => {
        const userId = event.params.uid;
        const value = event.data.val();
        const newData = event.data._newData;
        const prevData = event.data.previous._newData;

        var newPlaceIds = [];
        var oldPlaceIds = [];

        Object.keys(prevData).forEach(key => {
            oldPlaceIds.push(key);
        });

        Object.keys(newData).forEach(key => {
            newPlaceIds.push(key);
        });

        oldPlaceIds.sort();
        newPlaceIds.sort();

        var removedPlaces = oldPlaceIds.filter(function (element) {
            return !newPlaceIds.includes(element);
        });

        var addPlaces = newPlaceIds.filter(function (element) {
            return !removedPlaces.includes(element);
        });


        var updateObject = {}

        for (var i = 0; i < removedPlaces.length; i++) {
            updateObject['lookups/userplace/' + removedPlaces[i] + '/' + userId] = null;
        }

        for (var j = 0; j < addPlaces.length; j++) {
            updateObject['lookups/userplace/' + addPlaces[j] + '/' + userId] = true;
        }

        var placeIds = [];
        var promises = [];

        Object.keys(newData).forEach(key => {
            placeIds.push(key);
            const tempPromise = database.ref('/places/' + key + '/posts').once('value');
            promises.push(tempPromise);
        });

        return Promise.all(promises).then(results => {

            var nearbyStories = {}
            for (var i = 0; i < results.length; i++) {
                var result = results[i];
                nearbyStories[placeIds[i]] = result.val();
            }
            updateObject['users/feed/nearby/' + userId] = nearbyStories;

            // Do a deep-path update
            return database.ref().update(updateObject).then(error => {
                if (error) {
                    console.log("Error updating data:", error);
                }
            });
        });
    });


exports.addNewPlace = functions.database.ref('/places/{placeId}/info').onWrite(event => {
    const placeId = event.params.placeId;
    const value = event.data.val();
    const prevData = event.data.previous._data;
    const newData = event.data._newData;

    if (prevData != null) {
        return
    }

    const userCoordsRef = database.ref('/users/location/coordinates/');
    return userCoordsRef.once('value').then(snapshot => {

        snapshot.forEach(function (userCoord) {
            const userId = userCoord.key;
            const lat = userCoord.val().lat;
            const lon = userCoord.val().lon;
            const rad = userCoord.val().rad;
            const place_lat = newData.lat;
            const place_lon = newData.lon;
            
            const distance = haversineDistance(lat, lon, place_lat, place_lon);
            if (distance <= rad) {
                database.ref('users/location/nearby/' + userId + '/' + placeId).set(distance);
            }
        });
    });
});

exports.addPostToNearbyFeed =
    functions.database.ref('/places/{placeId}/posts/{postKey}').onWrite(event => {
        const placeId = event.params.placeId;
        const postKey = event.params.postKey;
        const value = event.data.val();
        const newData = event.data._newData;
        const lookupRef = database.ref('lookups/userplace/' + placeId);

        var toRemove = false;
        if (value == null || newData == null) {
            toRemove = true;
        }

        return lookupRef.once('value').then(snapshot => {

            var updateObject = {};

            snapshot.forEach(function (user) {
                const userId = user.key;
                const path = '/users/feed/nearby/' + userId + '/' + placeId + '/' + postKey;
                updateObject[path] = (toRemove ? null : newData);
            });

            // Do a deep-path update
            return database.ref().update(updateObject).then(error => {
                if (error) {
                    console.log("Error updating data:", error);
                }
            });

        });
    });

exports.addPostToFollowingFeed = functions.database.ref('/users/story/{uid}/{postKey}').onWrite(event => {
    const userId = event.params.uid;
    const postKey = event.params.postKey;
    const value = event.data.val();
    const newData = event.data._newData;

    var toRemove = false;
    if (value == null || newData == null) {
        toRemove = true;
    }

    const followersRef = database.ref('users/social/followers/' + userId);

    return followersRef.once('value').then(snapshot => {
        var updateObject = {};

        snapshot.forEach(function (user) {
            const followerId = user.key;
            const path = '/users/feed/following/' + followerId + '/' + userId + '/' + postKey;
            updateObject[path] = (toRemove ? null : newData);
        });

        // Do a deep-path update
        return database.ref().update(updateObject).then(error => {
            if (error) {
                console.log("Error updating data:", error);
            }
        });
    });

});


function haversineDistance(lat1, lon1, lat2, lon2) {
    var p = 0.017453292519943295; // Math.PI / 180
    var c = Math.cos;
    var a = 0.5 - c((lat2 - lat1) * p) / 2 +
        c(lat1 * p) * c(lat2 * p) *
        (1 - c((lon2 - lon1) * p)) / 2;

    return 12742 * Math.asin(Math.sqrt(a)); // 2 * R; R = 6371 km
}