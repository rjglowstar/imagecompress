var jic = {
    compress: function (imageElement, qualityPercentage, fileType) {
        var mimeType = "image/jpeg";
        if (typeof fileType !== "undefined" && fileType === "png") {
            mimeType = "image/png";
        }
        var canvas = document.createElement("canvas");
        canvas.width = imageElement.naturalWidth;
        canvas.height = imageElement.naturalHeight;
        var context = canvas.getContext("2d");
        context.drawImage(imageElement, 0, 0);
        var compressedDataURL = canvas.toDataURL(mimeType, qualityPercentage / 100);
        var compressedImage = new Image();
        compressedImage.src = compressedDataURL;
        return compressedImage;
    },
    upload: function (
        imageElement,
        uploadURL,
        fieldName,
        fileName,
        successCallback,
        errorCallback,
        progressCallback,
        headers
    ) {
        if (typeof XMLHttpRequest.prototype.sendAsBinary === "undefined") {
            XMLHttpRequest.prototype.sendAsBinary = function (data) {
                var byteArray = Array.prototype.map.call(data, function (char) {
                    return 255 & char.charCodeAt(0);
                });
                this.send(new Uint8Array(byteArray).buffer);
            };
        }

        var mimeType = "image/jpeg";
        if (fileName.slice(-4) === ".png") {
            mimeType = "image/png";
        }
        var imageBase64 = imageElement.src;
        imageBase64 = imageBase64.replace("data:" + mimeType + ";base64,", "");
        var xhr = new XMLHttpRequest();
        xhr.open("POST", uploadURL, true);
        var boundary = "someboundary";
        xhr.setRequestHeader(
            "Content-Type",
            "multipart/form-data; boundary=" + boundary
        );

        if (headers && typeof headers === "object") {
            for (var headerKey in headers) {
                xhr.setRequestHeader(headerKey, headers[headerKey]);
            }
        }

        if (progressCallback && progressCallback instanceof Function) {
            xhr.upload.onprogress = function (event) {
                if (event.lengthComputable) {
                    progressCallback((event.loaded / event.total) * 100);
                }
            };
        }

        xhr.sendAsBinary(
            [
                "--" + boundary,
                'Content-Disposition: form-data; name="' +
                fieldName +
                '"; filename="' +
                fileName +
                '"',
                "Content-Type: " + mimeType,
                "",
                atob(imageBase64),
                "--" + boundary + "--",
            ].join("\r\n")
        );

        xhr.onreadystatechange = function () {
            if (this.readyState === 4) {
                if (this.status === 200) {
                    successCallback(this.responseText);
                } else if (
                    this.status >= 400 &&
                    errorCallback &&
                    errorCallback instanceof Function
                ) {
                    errorCallback(this.responseText);
                }
            }
        };
    },
};
