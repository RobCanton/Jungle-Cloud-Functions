const functions = require('firebase-functions');
const admin = require('firebase-admin');
const utilities = require('./utilities.js');

admin.initializeApp(functions.config().firebase);

const database = admin.database();

exports.removePostData = functions.database.ref('/admin/remove').onWrite(event => {
    const value = event.data.val();

    if (value == null) {
        return
    }

    const r1 = database.ref(`uploads`).remove();
    const r2 = database.ref(`places`).remove();
    const r3 = database.ref(`stories`).remove();
    const r4 = database.ref(`users/story`).remove();
    const r5 = database.ref(`users/feed`).remove();
    const r6 = database.ref(`users/location`).remove();
    const r7 = database.ref(`users/uploads`).remove();
    const r8 = database.ref(`users/viewed`).remove();
    const r9 = database.ref(`users/notifications`).remove();
    const r10 = database.ref(`notifications`).remove();
    return Promise.all([r1, r2, r3, r4, r5, r6, r7, r8, r9, r10]).then(event => {

    });
})

exports.runCleanUp = functions.database.ref('/admin/cleanup').onWrite(event => {
    const value = event.data.val();

    if (value == null) {
        return
    }

    const livePostsPromise = database.ref(`uploads/live`).once('value');

    return livePostsPromise.then(snapshot => {

        var updateObject = {};
        snapshot.forEach(function (post) {

            const key = post.key;
            const author = post.val().author;
            const place = post.val().place;
            const timestamp = post.val().timestamp;
            const age = utilities.getMinutesSinceNow(timestamp);

            if (age >= 1440) {
                if (place !== null || place !== undefined) {
                    updateObject[`stories/stats/places/${place}/posts/${key}`] = null;
                }

                updateObject[`stories/stats/users/${author}/posts/${key}`] = null;
                updateObject[`uploads/live/${key}`] = null;
                updateObject[`uploads/meta/${key}/live`] = false;

                clearViews(key);
            }
        });

        const removeCleanup = database.ref(`admin/cleanup`).remove();
        const update = database.ref().update(updateObject);


        return Promise.all([removeCleanup, update]).then(snapshot => {
            const updateResult = snapshot[1];
        }).catch(function (error) {
            console.log("Promise rejected: " + error);
        });

    }).catch(function (error) {
        console.log("Promise rejected: " + error);
    });
});

function clearViews(postKey) {
    const getViews = database.ref(`uploads/views/${postKey}`);

    return getViews.then(snapshot => {
        snapshot.forEach(function (uid) {
            database.ref(`users/viewed/${uid}/${postKey}`).remove();
        });

    });
}

/**
 * Triggers when a user gets a new follower and sends a notification.
 *
 * Followers add a flag to `/followers/{followedUid}/{followerUid}`.
 * Users save their device notification tokens to `/users/{followedUid}/notificationTokens/{notificationToken}`.
 */


exports.sendFollowerNotification = functions.database.ref('/social/following/{followerUid}/{followedUid}').onWrite(event => {
    const followerUid = event.params.followerUid;
    const followedUid = event.params.followedUid;
    const value = event.data.val();

    updateFollowerCounts(followerUid, followedUid);

    if (value == null) {
        return database.ref(`/social/followers/${followedUid}/${followerUid}`).remove();
    }

    let notificationObject = {};

    // Custom key pattern so that all follow notifications are user -> user specific
    let nKey = `follow:${followedUid}:${followerUid}`;

    notificationObject[`notifications/${nKey}`] = {
        "type": 'FOLLOW',
        "sender": followerUid,
        "recipient": followedUid,
        "timestamp": admin.database.ServerValue.TIMESTAMP
    }
    notificationObject[`users/notifications/${followedUid}/${nKey}`] = false;

    const promises = [
        database.ref().update(notificationObject),
        database.ref(`/social/blocked/${followerUid}/${followedUid}`).remove(),
        database.ref(`/social/blocked_by/${followedUid}/${followerUid}`).remove(),
        database.ref(`/social/followers/${followedUid}/${followerUid}`).set(false)
    ];

    return Promise.all(promises).then(results => {
        const setNotificationResult = results[0];
    }).catch(function (error) {
        console.log("Promise rejected: " + error);
    });

});


function updateFollowerCounts(followerUid, followedUid) {

    const follower_count = database.ref(`social/following/${followerUid}`).once('value');
    const followed_count = database.ref(`social/followers/${followedUid}`).once('value');

    return Promise.all([follower_count, followed_count]).then(results => {
        const following = results[0];
        const followers = results[1];

        const setFollowingCount = database.ref(`users/profile/${followerUid}/following`).set(following.numChildren());
        const setFollowersCount = database.ref(`users/profile/${followedUid}/followers`).set(followers.numChildren());

        return Promise.all([setFollowingCount, setFollowersCount]).then(results => {

        });
    });
}

exports.processUserBlocked = functions.database.ref('/social/blocked/{uid}/{blocked_uid}').onWrite(event => {
    const uid = event.params.uid;
    const blocked_uid = event.params.blocked_uid;
    const value = event.data.val();

    if (value == null) {
        const conv_ref_1   = database.ref(`users/conversations/${blocked_uid}/${uid}/blocked`).remove();
        const conv_ref_2   = database.ref(`users/conversations/${uid}/${blocked_uid}/blocked`).remove();
        return Promise.all([conv_ref_1, conv_ref_2]).then( results => {
            
        });
    }

    
    const follow_ref_1 = database.ref(`social/followers/${uid}/${blocked_uid}`).remove();
    const follow_ref_2 = database.ref(`social/following/${uid}/${blocked_uid}`).remove();
    const follow_ref_3 = database.ref(`social/followers/${blocked_uid}/${uid}`).remove();
    const follow_ref_4 = database.ref(`social/following/${blocked_uid}/${uid}`).remove();
    const conv_ref_1   = database.ref(`users/conversations/${blocked_uid}/${uid}/blocked`).set(true);
    const conv_ref_2   = database.ref(`users/conversations/${uid}/${blocked_uid}/blocked`).set(true);

    return Promise.all([follow_ref_1, follow_ref_2, follow_ref_3, follow_ref_4, conv_ref_1, conv_ref_2]).then(results => {
        console.log("Follow social removed");

    }).catch(function (error) {
        console.log("Promise rejected: " + error);
    });
});

/*  Process Uploads
    - If new post, add to follower feeds
    - If removed post, remove from follower follower feeds
*/

exports.processUploads =
    functions.database.ref('/uploads/meta/{uploadKey}').onWrite(event => {
        const uploadKey = event.params.uploadKey;
        const value = event.data.val();
        const newData = event.data._newData;
        const prevData = event.data.previous._data;

        if (value == null) {
            return deletePost(uploadKey, prevData.author, prevData.placeID);
        }

        if (prevData !== null) {
            return;
        }

        const author = newData.author;
        const dateCreated = newData.dateCreated;
        const liveUpdate = database.ref(`uploads/live/${uploadKey}`).set({
            "author": author,
            "place": newData.placeID,
            "timestamp": dateCreated
        });

        const followersRef = database.ref(`social/followers/${author}`).once('value');

        return Promise.all([liveUpdate, followersRef]).then(results => {
            let liveResults = results[0];
            let snapshot = results[1];

            if (snapshot.exists()) {

                snapshot.forEach(function (follower) {
                    const followerUid = follower.key;

                    const tempRef = database.ref(`social/stories/${followerUid}/${author}/${uploadKey}`);
                    tempRef.set(dateCreated);

                });
            }
        });
    });

function deletePost(key, author, placeId) {
    console.log("Delete post: ", key);

    if (placeId !== null || placeId !== undefined) {
        database.ref(`stories/stats/places/${placeId}/posts/${key}`).remove();
    }

    database.ref(`stories/stats/users/${author}/posts/${key}`).remove();
    database.ref(`users/uploads/${author}/${key}`).remove();
    database.ref(`uploads/comments/${key}`).remove();

    const postNotifications = database.ref(`uploads/notifications/${key}`);

    return Promise.all([]).once('value').then(snapshot => {
        snapshot.forEach(function (notificationPair) {
            const notificationKey = notificationPair.key;
            const recipient = notificationPair.val();
            database.ref(`notifications/${notificationKey}`).remove();
        });
    }).catch(function (error) {
        console.log("Promise rejected: " + error);
    });
}

exports.processNotifications = functions.database.ref('/notifications/{notificationKey}').onWrite(event => {
    const notificationKey = event.params.notificationKey;
    const value = event.data.val();
    const prevData = event.data.previous._data;
    const newData = event.data._newData;

    if (value == null && prevData !== null) {
        const postKey = prevData.postKey;
        const recipient = prevData.recipient;
        database.ref(`users/notifications/${recipient}/${notificationKey}`).remove();
        database.ref(`uploads/notifications/${postKey}/${notificationKey}`).remove();
        return console.log('Notification deleted: ', notificationKey);
    }

    const type = newData.type;
    const sender = newData.sender;
    const recipient = newData.recipient;
    const text = newData.text;

    console.log("New notification: ", type, " from ", sender, " to ", recipient);


    const getRecipientSettings = database.ref(`/users/settings/${recipient}/push_notifications`).once('value');
    return getRecipientSettings.then(snapshot => {

        if (snapshot.exists() && !snapshot.val()) {
            return
        }

        const getSenderUsername = database.ref(`/users/profile/${sender}/username`).once('value');
        const getRecipientToken = database.ref(`/users/FCMToken/${recipient}`).once('value');

        return Promise.all([getSenderUsername, getRecipientToken]).then(results => {
            const senderUsername = results[0].val();
            const recipientToken = results[1].val();

            var pushNotificationPayload = {};
            if (type === "FOLLOW") {
                pushNotificationPayload = {
                    notification: {
                        body: `${senderUsername} started following you.`,
                    }
                };

            } else if (type === "MENTION" && text !== null && text !== undefined) {
                pushNotificationPayload = {
                    notification: {
                        body: `${senderUsername} mentioned you in a comment: "${text}"`
                    }
                };
            } else if (type === "COMMENT" && text !== null && text !== undefined) {
                pushNotificationPayload = {
                    notification: {
                        body: `${senderUsername} commented on your post: "${text}"`
                    }
                };
            }

            console.log("Send payload: ", pushNotificationPayload);

            const sendPushNotification = admin.messaging().sendToDevice(recipientToken, pushNotificationPayload);
            return sendPushNotification.then(pushResult => {
                console.log("Push notification sent.");
            }).catch(function (error) {
                console.log("Promise rejected: " + error);
            });
        }).catch(function (error) {
            console.log("Promise rejected: " + error);
        });
    }).catch(function (error) {
        console.log("Promise rejected: " + error);
    });
});

exports.sendCommentNotification = functions.database.ref('/uploads/comments/{postKey}/{commentKey}').onWrite(event => {
    const postKey = event.params.postKey;
    const commentKey = event.params.commentKey;
    const value = event.data.val();
    const newData = event.data._newData;

    if (value == null || newData == null) {
        const postCommentsPromise = database.ref(`/uploads/comments/${postKey}`).once('value');

        return postCommentsPromise.then(results => {

            var numComments = 0;
            if (results.exists()) {
                numComments = results.numChildren()
            }
            const numCommentsPromise = database.ref(`/uploads/meta/${postKey}/comments`).set(numComments);
            return numCommentsPromise.then(result => {

            }).catch(function (error) {
                console.log("Promise rejected: " + error);
            });
        }).catch(function (error) {
            console.log("Promise rejected: " + error);
        });
    }

    const sender = newData.author;

    const postAuthorPromise = database.ref(`uploads/meta/${postKey}`).once('value');
    const postCommentsPromise = database.ref(`/uploads/comments/${postKey}`).once('value');
    const postSubscribersPromise = database.ref(`/uploads/subscribers/${postKey}`).once('value');
    return Promise.all([postAuthorPromise, postCommentsPromise, postSubscribersPromise]).then(results => {
        const postMeta = results[0].val();
        const postAuthor = postMeta.author;
        const live = postMeta.live;
        const placeId = postMeta.placeID;
        const commentsResults = results[1];
        const subscribersResults = results[2];

        /* Update post meta with number of comments */
        var numComments = 0;
        var commenters = [];
        var participants = {};
        if (commentsResults.exists()) {

            numComments = commentsResults.numChildren()
            var array = [];
            commentsResults.forEach(function (comment) {
                array.push(comment.val().author);
                participants[comment.val().author] = true;
            });

            commenters = array.unique();
            console.log("Commenters: ", commenters);
        }

        var metaUpdateObject = {};
        metaUpdateObject[`/uploads/meta/${postKey}/comments`] = numComments;
        metaUpdateObject[`/uploads/meta/${postKey}/commenters`] = commenters.length;

        if (live) {
            metaUpdateObject[`/stories/stats/users/${postAuthor}/posts/${postKey}/c`] = numComments;
            metaUpdateObject[`/stories/stats/users/${postAuthor}/posts/${postKey}/p`] = participants;

            if (placeId !== null && placeId !== undefined) {
                metaUpdateObject[`/places/${placeId}/posts/${postKey}/c`] = numComments;
                metaUpdateObject[`/places/${placeId}/posts/${postKey}/p`] = participants;
            }
        }
        const metaUpdatePromise = database.ref().update(metaUpdateObject);

        /* Write comment notifications to post author and mentioned users  */
        var notificationObject = {};

        const trimmedString = utilities.trimTextForNotification(newData.text);
        if (trimmedString !== null) {

            subscribersResults.forEach(function (subscriber) {

                let subscriber_uid = subscriber.key;

                if (subscriber_uid !== sender) {

                    let nKey = `comment:${postKey}:${subscriber_uid}`
                    let notificationRef = database.ref(`users/notifications/${subscriber_uid}/${nKey}`);

                    var type = 'COMMENT';
                    var count = count = commenters.length;
                    const i = commenters.containsAtIndex(subscriber_uid);
                    if (i !== null) {
                        count -= 1;
                    }

                    if (subscriber_uid !== postAuthor) {
                        if (i !== null) {
                            type = 'COMMENT_ALSO';
                            count = commenters.slice(i + 1).length;
                        } else {
                            type = 'COMMENT_TO_SUB';
                        }
                    }

                    notificationObject[`notifications/${nKey}`] = {
                        "type": type,
                        "postKey": postKey,
                        "sender": sender,
                        "recipient": subscriber_uid,
                        "text": trimmedString,
                        "commenters": count,
                        "timestamp": admin.database.ServerValue.TIMESTAMP
                    }

                    notificationObject[`users/notifications/${subscriber_uid}/${nKey}`] = false;
                }
            });

        }

        const notificationPromise = database.ref().update(notificationObject);

        return Promise.all([metaUpdatePromise, notificationPromise]).then(results => {

        }).catch(function (error) {
            console.log("Promise rejected: " + error);
        });
    });


});

exports.updateViewsMeta = functions.database.ref('/uploads/views/{postKey}/{uid}').onWrite(event => {
    const userId = event.params.uid;
    const postKey = event.params.postKey;
    const value = event.data.val();
    const newData = event.data._newData;
    var toRemove = false;
    if (value == null) {
        toRemove = true;
    }

    const postDataPromise = database.ref(`/uploads/meta/${postKey}`).once('value');
    const postViewsPromise = database.ref(`/uploads/views/${postKey}`).once('value');

    return Promise.all([postDataPromise, postViewsPromise]).then(results => {
        const postMeta = results[0].val();
        const postViews = results[1];
        const author = postMeta.author;
        const live = postMeta.live;
        const placeId = postMeta.placeID;

        var metaUpdateObject = {};
        metaUpdateObject[`/uploads/meta/${postKey}/views`] = postViews.numChildren();

        if (live && postViews.val() !== null && postViews.val() !== undefined) {
            metaUpdateObject[`/stories/stats/users/${author}/posts/${postKey}/v`] = postViews.val();

            if (placeId !== null && placeId !== undefined) {
                metaUpdateObject[`/stories/stats/places/${placeId}/posts/${postKey}/v`] = postViews.val();
            }
        }

        const metaUpdatePromise = database.ref().update(metaUpdateObject);

        return metaUpdatePromise.then(result => {

        }).catch(function (error) {
            console.log("Promise rejected: " + error);
        });
    }).catch(function (error) {
        console.log("Promise rejected: " + error);
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

    const placesRef = database.ref('places').once('value');
    const userCoordsRef = database.ref('stories/sorted/coordinates').once('value');
    const followingRef = database.ref(`social/following/${userId}/`).once('value');

    return Promise.all([followingRef, userCoordsRef, placesRef]).then(results => {
        const followingSnapshot = results[0];
        const usersSnapshot = results[1];
        const placesSnapshot = results[2];

        var following = {};
        var followingWithNearbyStories = {};
        followingSnapshot.forEach(function (user) {
            following[user.key] = true;
        });

        var nearbyUserIds = {};

        usersSnapshot.forEach(function (user) {
            const uid = user.key;
            const user_lat = user.val().lat;
            const user_lon = user.val().lon;

            const distance = utilities.haversineDistance(lat, lon, user_lat, user_lon);
            if (distance <= rad && uid !== userId) {
                nearbyUserIds[uid] = distance;
                if (following[uid] !== null && following[uid] !== undefined) {
                    followingWithNearbyStories[uid] = distance;
                }
            }
        });

        var nearbyPlaceIds = {};

        placesSnapshot.forEach(function (place) {
            const id = place.key;
            const name = place.val().name;
            const place_lat = place.val().info.lat;
            const place_lon = place.val().info.lon;

            const distance = utilities.haversineDistance(lat, lon, place_lat, place_lon);
            if (distance <= rad) {
                nearbyPlaceIds[id] = distance;
            }
        });

        var nearbyUpdateObject = {};

        nearbyUpdateObject[`users/location/nearby/${userId}/following`] = followingWithNearbyStories;
        nearbyUpdateObject[`users/location/nearby/${userId}/users`] = nearbyUserIds;
        nearbyUpdateObject[`users/location/nearby/${userId}/places`] = nearbyPlaceIds;
        const updatePromise = database.ref().update(nearbyUpdateObject);
        return updatePromise.then(result => {

        });

    }).catch(function (error) {
        console.log("Promise rejected: " + error);
    });
});

exports.conversationMetaUpdate = functions.database.ref('/conversations/{conversationKey}/meta').onWrite(event => {
    const conversationKey = event.params.conversationKey;
    const value = event.data.val();
    const prevData = event.data.previous._data;
    const newData = event.data._newData;

    const uids = conversationKey.split(":");
    const uidA = uids[0];
    const uidB = uids[1];

    var lastSeenA = newData[uidA];
    const lastSeenB = newData[uidB];
    const lastMessage = newData.latest;
    const text = newData.text;

    console.log(`lastSeenA: ${lastSeenA} lastSeenB: ${lastSeenB} lastest: ${lastMessage} text: ${text}`);

    var updateObject = {};

    if (lastSeenA == null || lastSeenA == undefined) {
        return database.ref(`/conversations/${conversationKey}/meta/${uidA}`).set(0).then(result => {});
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

    }).catch(function (error) {
        console.log("Promise rejected: " + error);
    });
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
    metaObject["A"] = uidA;
    metaObject["B"] = uidB;

    const promises = [
        event.data.adminRef.parent.parent.child("meta").update(metaObject),
        database.ref(`/users/settings/${recipientId}/push_notifications`).once('value')
    ];

    return Promise.all(promises).then(results => {
        const settings = results[1];

        if (settings.exists() && !settings.val()) {
            return
        }
        const getSenderUsername = database.ref(`/users/profile/${senderId}/username`).once('value');
        const getRecipientToken = database.ref(`/users/FCMToken/${recipientId}`).once('value');

        return Promise.all([getSenderUsername, getRecipientToken]).then(results => {
            const username = results[0].val();
            const token = results[1].val();

            const pushNotificationPayload = {
                notification: {
                    body: `${username}: ${text}`
                }
            };

            const sendPushNotification = admin.messaging().sendToDevice(token, pushNotificationPayload);
            return sendPushNotification.then(pushResult => {

            }).catch(function (error) {
                console.log("Promise rejected: " + error);
            });
        });
    }).catch(function (error) {
        console.log("Promise rejected: " + error);
    });
});

exports.updateStoryMeta = functions.database.ref('/stories/stats/users/{uid}/posts/{postKey}').onWrite(event => {
    const uid = event.params.uid;
    const postKey = event.params.postKey;

    const value = event.data.value;
    const getStoryPostsPromise = database.ref(`/stories/stats/users/${uid}/posts`).once('value');

    return getStoryPostsPromise.then(snapshot => {

        if (!snapshot.exists()) {
            const removeStory = database.ref(`stories/users/${uid}`).remove();
            const removePopularity = database.ref(`stories/sorted/popular/userStories/${uid}`).remove();
            const removeRecent = database.ref(`stories/sorted/recent/userStories/${uid}`).remove();
            const removeCoordinates = database.ref(`stories/sorted/coordinates/${uid}`).remove();
            return Promise.all([removeStory, removePopularity, removeRecent, removeCoordinates]);
        }

        var totalNumComments = 0;
        var numPosts = 0;

        var allParticipants = {};
        var allViewers = {};

        var postKeys = [];

        var mostRecentKey = "";
        var mostRecentTimestamp = 0;
        var mostRecentCoords = {};

        snapshot.forEach(function (post) {
            const val = post.val();
            mostRecentKey = post.key;
            postKeys[post.key] = true;
            numPosts += 1;
            Object.assign(allParticipants, val.p);
            Object.assign(allViewers, val.v);
            mostRecentTimestamp = val.t;
            mostRecentCoords = {
                "lat": val.lat,
                "lon": val.lon
            };
        });

        const totalNumParticipants = Object.keys(allParticipants).length;
        const totalNumViews = Object.keys(allViewers).length;

        const score = utilities.calculateUserStoryPopularityScore(numPosts, totalNumViews, totalNumParticipants);

        const metaObject = {
            "meta": {
                "k": mostRecentKey,
                "p": score,
                "t": mostRecentTimestamp
            },
            "posts": postKeys
        }

        const setStoryMeta = database.ref(`stories/users/${uid}/`).set(metaObject);
        const setPopularity = database.ref(`stories/sorted/popular/userStories/${uid}`).set(score);
        const setRecent = database.ref(`stories/sorted/recent/userStories/${uid}`).set(mostRecentTimestamp);
        const setCoordinates = database.ref(`stories/sorted/coordinates/${uid}`).set(mostRecentCoords);

        return Promise.all([setStoryMeta, setPopularity, setRecent, setCoordinates]).then(result => {

            return database.ref(`operational/refresh/${uid}`).set(true);
        }).catch(error => {
            console.log("Promise rejected: " + error);
        });

    });

});

exports.updatePlaceMeta = functions.database.ref('/stories/stats/places/{placeId}/posts/{postKey}').onWrite(event => {
    const placeId = event.params.placeId;
    const postKey = event.params.postKey;

    const getPlacesPostsPromise = database.ref(`/stories/stats/places/${placeId}/posts/`).once('value');
    return getPlacesPostsPromise.then(snapshot => {

        if (!snapshot.exists()) {
            const removeStory = database.ref(`stories/places/${placeId}`).remove();
            const removePopularity = database.ref(`stories/sorted/popular/places/${placeId}`).remove();
            const removeRecent = database.ref(`stories/sorted/recent/places/${placeId}`).remove();

            return Promise.all([removeStory, removePopularity, removeRecent]);
        }

        var totalNumComments = 0;
        var numPosts = 0;

        var allParticipants = {};
        var allViewers = {};

        var postKeys = [];

        var mostRecentKey = "";
        var mostRecentTimestamp = 0;

        snapshot.forEach(function (post) {
            const val = post.val();
            mostRecentKey = post.key;
            postKeys[post.key] = true;
            numPosts += 1;
            Object.assign(allParticipants, val.p);
            Object.assign(allViewers, val.v);
            mostRecentTimestamp = val.t;
        });


        const totalNumParticipants = Object.keys(allParticipants).length;
        const totalNumViews = Object.keys(allViewers).length;

        const score = utilities.calculatePlaceStoryPopularityScore(numPosts, totalNumViews, totalNumParticipants);

        const metaObject = {
            "meta": {
                "k": mostRecentKey,
                "p": score,
                "t": mostRecentTimestamp
            },
            "posts": postKeys
        }

        const setStoryMeta = database.ref(`stories/places/${placeId}/`).set(metaObject);
        const setPopularity = database.ref(`stories/sorted/popular/places/${placeId}`).set(score);
        const setRecent = database.ref(`stories/sorted/recent/places/${placeId}`).set(mostRecentTimestamp);

        return Promise.all([setStoryMeta, setPopularity, setRecent]).then(result => {

        }).catch(error => {
            console.log("Promise rejected: " + error);
        });

    });

});

exports.updateUserUploadCount = functions.database.ref('/users/uploads/{uid}/{postKey}').onWrite(event => {
    const uid = event.params.uid;
    const value = event.data.value;
    
    return database.ref(`users/uploads/${uid}`).once('value').then( snapshot => {
       
        return database.ref(`users/profile/${uid}/posts`).set(snapshot.numChildren());
    });
});



Array.prototype.containsAtIndex = function (v) {
    for (var i = 0; i < this.length; i++) {
        if (this[i] === v) return i;
    }
    return null;
};

Array.prototype.unique = function () {
    var arr = [];
    for (var i = 0; i < this.length; i++) {
        const j = arr.containsAtIndex(this[i]);
        if (j !== null) {
            arr.splice(j, 1);
            arr.push(this[i]);
        } else {
            arr.push(this[i]);
        }
    }
    return arr;
}