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