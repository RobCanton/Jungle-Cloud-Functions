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
    
    return Promise.all([r1, r2, r3, r4, r5, r6, r7]).then( event => {
        
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
                    updateObject[`places/${place}/posts/${key}`] = null;
                }

                updateObject[`users/story/${author}/posts/${key}`] = null;
                updateObject[`uploads/live/${key}`] = null;
                updateObject[`uploads/meta/${key}/live`] = false;
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
        database.ref(`/users/profile/${followerUid}/username/`).once('value'),
        database.ref(`/users/story/${followedUid}/posts`).once('value'),
        database.ref(`/users/social/blocked/${followerUid}/${followedUid}`).remove(),
        database.ref(`/users/social/blocked_by/${followedUid}/${followerUid}`).remove()
    ];

    return Promise.all(promises).then(results => {
        const setNotificationResult = results[0];
        const username = results[1].val();
        const followedStory = results[2].val();

        const updateFollowerFeedPromise = followerFeedRef.set(followedStory);

        return updateFollowerFeedPromise.then(results => {

        }).catch(function (error) {
            console.log("Promise rejected: " + error);
        });
    }).catch(function (error) {
        console.log("Promise rejected: " + error);
    });

});

exports.processUserBlocked = functions.database.ref('/users/social/blocked/{uid}/{blocked_uid}').onWrite(event => {
    const uid = event.params.uid;
    const blocked_uid = event.params.blocked_uid;
    const value = event.data.val();

    if (value == null) {
        return;
    }

    const follow_ref_1 = database.ref(`users/social/followers/${uid}/${blocked_uid}`).remove();
    const follow_ref_2 = database.ref(`users/social/following/${uid}/${blocked_uid}`).remove();
    const follow_ref_3 = database.ref(`users/social/followers/${blocked_uid}/${uid}`).remove();
    const follow_ref_4 = database.ref(`users/social/following/${blocked_uid}/${uid}`).remove();

    return Promise.all([follow_ref_1, follow_ref_2, follow_ref_3, follow_ref_4]).then(results => {
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

        const followersRef = database.ref(`users/social/followers/${author}`).once('value');

        return Promise.all([liveUpdate, followersRef]).then(results => {
            let liveResults = results[0];
            let snapshot = results[1];

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
    database.ref(`users/story/${author}/posts/${key}`).remove();
    database.ref(`users/uploads/${author}/${key}`).remove();
    database.ref(`uploads/comments/${key}`).remove();

    const postNotifications = database.ref(`uploads/notifications/${key}`);

    return postNotifications.once('value').then(snapshot => {
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
            metaUpdateObject[`/users/story/${postAuthor}/posts/${postKey}/c`] = numComments;
            metaUpdateObject[`/users/story/${postAuthor}/posts/${postKey}/p`] = participants;
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

    return Promise.all([postDataPromise, postViewsPromise]).then( results => {
        const postData = results[0].val();
        const postViews  = results[1];
        
        var metaUpdateObject = {};
        metaUpdateObject[`/uploads/meta/${postKey}/views`] = postViews.numChildren();
        
        if (postData.live && postViews.val() !== null && postViews.val() !== undefined) {
            metaUpdateObject[`/users/story/${postData.author}/posts/${postKey}/v`] = postViews.val();
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

    const placesRef = database.ref('places');

    var nearbyPlaceIds = {};

    return placesRef.once('value').then(snapshot => {
        snapshot.forEach(function (place) {
            const id = place.key;
            const name = place.val().name;
            const place_lat = place.val().info.lat;
            const place_lon = place.val().info.lon;

            var distance = utilities.haversineDistance(lat, lon, place_lat, place_lon);
            if (distance <= rad) {
                nearbyPlaceIds[id] = distance;
            }
        });
        const setNearbyIdsPromise = database.ref(`users/location/nearby/${userId}/`).set(nearbyPlaceIds);
        return setNearbyIdsPromise.then(result => {

        }).catch(function (error) {
            console.log("Promise rejected: " + error);
        });

    }).catch(function (error) {
        console.log("Promise rejected: " + error);
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
        var promises = [
            database.ref(`users/social/blocked/${userId}`).once('value')
        ];

        Object.keys(newData).forEach(key => {
            placeIds.push(key);
            const tempPromise = database.ref(`/places/${key}/posts`).once('value');
            promises.push(tempPromise);
        });

        return Promise.all(promises).then(results => {
            var blockedResults = results[0];
            var blocked_uids = {};
            blockedResults.forEach(function (blocked_uid) {
                blocked_uids[blocked_uid.key] = true;
            });

            var nearbyStories = {};
            for (var i = 1; i < results.length; i++) {
                const result = results[i];
                const placeId = placeIds[i - 1];
                if (result.exists()) {

                    var filteredPosts = {};
                    result.forEach(function (post) {
                        const author = post.val().a;
                        const timestamp = post.val().t;
                        const blocked = blocked_uids[author];
                        if (blocked == null || blocked == undefined) {
                            filteredPosts[post.key] = timestamp;
                        }
                    });
                    if (filteredPosts != {}) {

                        nearbyStories[placeId] = {
                            "distance": newData[placeId],
                            "posts": filteredPosts
                        }
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
            }).catch(function (error) {
                console.log("Promise rejected: " + error);
            });
        });
    })









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

            const distance = utilities.haversineDistance(lat, lon, place_lat, place_lon);
            if (distance <= rad) {
                database.ref(`users/location/nearby/${userId}/${placeId}`).set(distance);
            }
        });
    }).catch(function (error) {
        console.log("Promise rejected: " + error);
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
            }).catch(function (error) {
                console.log("Promise rejected: " + error);
            });

        }).catch(function (error) {
            console.log("Promise rejected: " + error);
        });
    });

exports.addPostToFollowingFeed = functions.database.ref('/users/story/{uid}/posts/{postKey}').onWrite(event => {
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

        // Do a deep-path update
        return database.ref().update(updateObject).then(error => {
            if (error) {
                console.log("Error updating data:", error);
            }
        }).catch(function (error) {
            console.log("Promise rejected: " + error);
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

    const promises = [
        event.data.adminRef.parent.parent.child("meta").update(metaObject),
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

        }).catch(function (error) {
            console.log("Promise rejected: " + error);
        });

    }).catch(function (error) {
        console.log("Promise rejected: " + error);
    });
});

exports.updateStoryMeta = functions.database.ref('/users/story/{uid}/posts/{postKey}').onWrite(event => {
    const uid = event.params.uid;
    const postKey = event.params.postKey;

    const getStoryPostsPromise = database.ref(`/users/story/${uid}/posts`).once('value');
    return getStoryPostsPromise.then(snapshot => {

        var totalNumComments = 0;
        var numPosts = 0;

        var allParticipants = {};
        var allViewers = {};
        snapshot.forEach(function (post) {
            const val = post.val();
            numPosts += 1;
            Object.assign(allParticipants, val.p);
            Object.assign(allViewers, val.v);
        });
        
        const totalNumParticipants = Object.keys(allParticipants).length;
        const totalNumViews = Object.keys(allViewers).length;
        
        const score = utilities.calculateUserStoryPopularityScore(numPosts, totalNumViews, totalNumParticipants);
        
        var metaObject = {};
        metaObject[`/stories/sorted/popular/userStories/${uid}`] = score;
        metaObject[`/stories/users/${uid}/meta/p`] = score;
        const updateMetaPromise = database.ref().update(metaObject);
        return updateMetaPromise.then( result => {
            
        }).catch(error => {
            console.log("Promise rejected: " + error);
        });

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