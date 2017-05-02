0
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

    const followerFeedRef = database.ref(`/users/feed/following/${followerUid}/${followedUid}`);

    if (value == null) {
        return followerFeedRef.remove().then(error => {});
    }

    const promises = [
        createFollowNotification(followerUid, followedUid),
        database.ref(`/users/profile/${followerUid}/username/`).once('value'),
        database.ref(`/users/FCMToken/${followedUid}`).once('value'),
        database.ref(`/users/story/${followedUid}`).once('value')
    ]

    return Promise.all(promises).then(results => {
        const setNotificationResult = results[0];
        const username = results[1].val();
        const token = results[2].val();
        const followedStory = results[3].val();

        const pushNotificationPayload = {
            notification: {
                body: `${username} started following you.`,
            }
        };

        const sendPushNotification = admin.messaging().sendToDevice(token, pushNotificationPayload);
        const updateFollowerFeedPromise = followerFeedRef.set(followedStory);

        return Promise.all([sendPushNotification, updateFollowerFeedPromise]).then(results => {

        });
    });

});

function createFollowNotification(sender, recipient) {
    let notificationObject = {};

    // Custom key pattern so that all follow notifications are user -> user specific
    let nKey = "follow:" + sender;

    notificationObject[`notifications/${nKey}`] = {
        "type": 'FOLLOW',
        "sender": sender,
        "recipient": recipient,
        "timestamp": admin.database.ServerValue.TIMESTAMP
    }
    notificationObject[`users/notifications/${recipient}/${nKey}`] = false;

    // Do a deep-path update
    return database.ref().update(notificationObject);
};
exports.processUploads =
    functions.database.ref('/uploads/meta/{uploadKey}').onWrite(event => {
        const uploadKey = event.params.uploadKey;
        const value = event.data.val();
        const newData = event.data._newData;
        const prevData = event.data.previous._data;

        if (value == null) {
            return deletePost(uploadKey, prevData.author, prevData.placeID);
        }

        const author = newData.author;
        const dateCreated = newData.dateCreated;

        const followersRef = database.ref(`users/social/followers/${author}`);

        return followersRef.once('value').then(snapshot => {
            if (snapshot.exists()) {

                snapshot.forEach(function (follower) {
                    const followerUid = follower.key;

                    const tempRef = database.ref(`users/social/stories/${followerUid}/${author}/${uploadKey}`);
                    tempRef.set(dateCreated);

                });
            }
        });
    });

function deletePost(key, author, placeId) {
    console.log("Delete post: ", key);

    database.ref(`places/${placeId}/posts/${key}`).remove();
    database.ref(`users/story/${author}/${key}`).remove();
    database.ref(`users/uploads/${author}/${key}`).remove();
    database.ref(`uploads/comments/${key}`).remove();

    const postNotifications = database.ref(`uploads/notifications/${key}`);

    return postNotifications.once('value').then(snapshot => {
        snapshot.forEach(function (notificationPair) {
            const notificationKey = notificationPair.key;
            const recipient = notificationPair.val();
            database.ref(`notifications/${notificationKey}`).remove();
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
        database.ref(`users/notifications/${recipient}/${notificationKey}`).remove();
        database.ref(`uploads/notifications/${postKey}/${notificationKey}`).remove();
        return console.log('Notification deleted: ', notificationKey);
    }

    return;
});

exports.sendCommentNotification = functions.database.ref('/uploads/comments/{postKey}/{commentKey}').onWrite(event => {
    const postKey = event.params.postKey;
    const commentKey = event.params.commentKey;
    const value = event.data.val();
    const newData = event.data._newData;

    if (value == null || newData == null) {
        return;
    }

    const sender = newData.author;

    var usernameLookups = [];
    var mentions = extractMentions(newData.text);
    for (var i = 0; i < mentions.length; i++) {
        mentions[i] = mentions[i].substring(1);
        const username = mentions[i];
        const lookupPromise = database.ref(`users/lookup/username/${mentions[i]}`).once('value');
        usernameLookups.push(lookupPromise);
    }

    return Promise.all(usernameLookups).then(results => {
        for (var j = 0; j < mentions.length; j++) {
            const mention = mentions[j];
            const result = results[j].val();

            if (result == null) {
                return event.data.ref.remove();
            }

            console.log("@", mention, " -> ", result);
        }

        console.log("Retrieved all mentioned user IDs.");

        // CONTINUE

        const postPromise = database.ref(`uploads/meta/${postKey}/author`).once('value');
        const postCommentsPromise = database.ref(`/uploads/comments/${postKey}`).once('value');

        return Promise.all([postPromise, postCommentsPromise]).then(results => {
            let recipient = results[0].val();
            let commentsResults = results[1];

            if (recipient === sender) {
                return
            }

            var promises = [
                database.ref(`/users/profile/${sender}/username/`).once('value'),
                database.ref(`/users/FCMToken/${recipient}`).once('value'),
            ];

            let notificationRef = database.ref(`users/notifications/${recipient}/`).push();
            let notificationObject = {};
            notificationObject[`notifications/${notificationRef.key}`] = {
                "type": 'COMMENT',
                "postKey": postKey,
                "sender": sender,
                "recipient": recipient,
                "timestamp": admin.database.ServerValue.TIMESTAMP
            }
            notificationObject[`users/notifications/${recipient}/${notificationRef.key}`] = false;
            const notificationPromise = database.ref().update(notificationObject);
            promises.push(notificationPromise);

            var numComments = 0;
            if (commentsResults.exists()) {
                numComments = commentsResults.numChildren()
            }
            const numCommentsPromise = database.ref(`/uploads/meta/${postKey}/comments`).set(numComments);
            promises.push(numCommentsPromise);

            return Promise.all(promises).then(results => {
                const username = results[0].val();
                const token = results[1].val();

                console.log("username: ", username, " token: ", token);

                var string = newData.text;
                var length = 32;
                var trimmedString = string.length > length ?
                    string.substring(0, length - 3) + "..." :
                    string;
                const pushNotificationPayload = {
                    notification: {
                        body: `${username} commented on your post: "${trimmedString}"`
                    }
                };

                const sendPushNotification = admin.messaging().sendToDevice(token, pushNotificationPayload);
                return sendPushNotification.then(pushResult => {

                });
            });
        });
    });

});

exports.updateUploadViewsMeta = functions.database.ref('/uploads/views/{postKey}/{uid}').onWrite(event => {
    const userId = event.params.uid;
    const postKey = event.params.postKey;
    const value = event.data.val();
    const newData = event.data._newData;
    var toRemove = false;
    if (value == null) {
        toRemove = true;
    }

    const postCommentsPromise = database.ref(`/uploads/views/${postKey}`).once('value');

    return postCommentsPromise.then(snapshot => {
        const numCommentsPromise = database.ref(`/uploads/meta/${postKey}/views`).set(snapshot.numChildren());
        return numCommentsPromise.then(result => {});
    });
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

            var distance = haversineDistance(lat, lon, place_lat, place_lon);
            if (distance <= rad) {
                nearbyPlaceIds[id] = distance;
            }
        });
        database.ref(`users/location/nearby/${userId}/`).set(nearbyPlaceIds);
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

        var updateObject = {}

        for (var i = 0; i < oldPlaceIds.length; i++) {
            updateObject[`lookups/userplace/${oldPlaceIds[i]}/${userId}/`] = null;
        }

        for (var j = 0; j < newPlaceIds.length; j++) {
            updateObject[`lookups/userplace/${newPlaceIds[j]}/${userId}/`] = newData[newPlaceIds[j]];
        }

        var placeIds = [];
        var promises = [];

        Object.keys(newData).forEach(key => {
            placeIds.push(key);
            const tempPromise = database.ref(`/places/${key}/posts`).once('value');
            promises.push(tempPromise);
        });

        return Promise.all(promises).then(results => {

            var nearbyStories = {};
            for (var i = 0; i < results.length; i++) {
                var result = results[i];
                var posts = result.val();
                if (posts != null) {
                    nearbyStories[placeIds[i]] = {
                        "distance": newData[placeIds[i]],
                        "posts": posts
                    }
                } else {
                    nearbyStories[placeIds[i]] = null;
                }
            }
            updateObject[`users/feed/nearby/${userId}`] = nearbyStories;

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
                database.ref(`users/location/nearby/${userId}/${placeId}`).set(distance);
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
        const lookupRef = database.ref(`lookups/userplace/${placeId}`);

        var toRemove = false;
        if (value == null || newData == null) {
            toRemove = true;
        }

        return lookupRef.once('value').then(snapshot => {

            var updateObject = {};

            snapshot.forEach(function (user) {
                const userId = user.key;
                const distance = user.val();
                const userFeedPath = `/users/feed/nearby/${userId}/${placeId}`;
                updateObject[`${userFeedPath}/posts/${postKey}`] = (toRemove ? null : newData);
                updateObject[`${userFeedPath}/distance`] = distance;
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

    const followersRef = database.ref(`users/social/followers/${userId}`);

    return followersRef.once('value').then(snapshot => {
        var updateObject = {};

        snapshot.forEach(function (user) {
            const followerId = user.key;
            const path = `/users/feed/following/${followerId}/${userId}/${postKey}`;
            updateObject[path] = (toRemove ? null : newData);
        });


        const userPath = `/users/feed/myStory/${userId}/${userId}/${postKey}`;
        updateObject[userPath] = (toRemove ? null : newData);

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

exports.conversationMetaUpdate = functions.database.ref('/conversations/{conversationKey}/meta').onWrite(event => {
    const conversationKey = event.params.conversationKey;
    const value = event.data.val();
    const prevData = event.data.previous._data;
    const newData = event.data._newData;

    const uids = conversationKey.split(":");
    const uidA = uids[0];
    const uidB = uids[1];


    console.log("newData: ", newData);
    var lastSeenA = newData[uidA];
    const lastSeenB = newData[uidB];
    const lastMessage = newData.latest;
    const text = newData.text;

    console.log(`lastSeenA: ${lastSeenA} lastSeenB: ${lastSeenB} lastest: ${lastMessage} text: ${text}`);

    var updateObject = {};

    if (lastSeenA == null || lastSeenA == undefined) {
        return database.ref(`/conversations/${conversationKey}/meta/${uidA}`).set(0).then(result => {});
        updateObject[`/conversations/${conversationKey}/meta/${uidA}`] = 0;
    }

    if (lastSeenB == null || lastSeenB == undefined) {
        return database.ref(`/conversations/${conversationKey}/meta/${uidB}`).set(0).then(result => {});
    }

    console.log("Conversation meta is complete");

    updateObject[`users/conversations/${uidA}/${uidB}/seen`] = lastSeenA >= lastMessage;
    updateObject[`users/conversations/${uidA}/${uidB}/latest`] = lastMessage;
    updateObject[`users/conversations/${uidA}/${uidB}/text`] = text;

    updateObject[`users/conversations/${uidB}/${uidA}/seen`] = lastSeenB >= lastMessage;
    updateObject[`users/conversations/${uidB}/${uidA}/latest`] = lastMessage;
    updateObject[`users/conversations/${uidB}/${uidA}/text`] = text;

    return database.ref().update(updateObject).then(result => {

    });

    return
});

exports.sendMessageNotification = functions.database.ref('/conversations/{conversationKey}/messages/{messageKey}').onWrite(event => {
    const conversationKey = event.params.conversationKey;
    const messageKey = event.params.messageKey;
    const newData = event.data._newData;
    console.log("Message: ", messageKey, " -> Conversation: ", conversationKey);

    const senderId = newData.senderId;
    const text = newData.text;
    const timestamp = newData.timestamp;
    if (newData == null || timestamp == null) {
        return
    }

    const uids = conversationKey.split(":");
    const uidA = uids[0];
    const uidB = uids[1];

    var recipientId = uidA;
    if (recipientId == senderId) {
        recipientId = uidB;
    }

    var metaObject = {}
    metaObject[senderId] = timestamp;
    metaObject["text"] = text;
    metaObject["latest"] = timestamp;

    const promises = [
        event.data.ref.parent.parent.child("meta").update(metaObject),
        database.ref(`/users/profile/${senderId}/username/`).once('value'),
        database.ref(`/users/FCMToken/${recipientId}`).once('value'),
    ];

    return Promise.all(promises).then(results => {
        const metaResults = results[0];
        const username = results[1].val();
        const token = results[2].val();

        console.log("Meta: ", metaResults, " username: ", username, " token: ", token);

        const pushNotificationPayload = {
            notification: {
                body: `${username}: ${text}`
            }
        };

        const sendPushNotification = admin.messaging().sendToDevice(token, pushNotificationPayload);
        return sendPushNotification.then(pushResult => {

        });

    });
});

function extractMentions(text) {
    const pattern = /\B@[a-z0-9_-]+/gi;
    let results = text.match(pattern);

    return results != null ? results : [];
}