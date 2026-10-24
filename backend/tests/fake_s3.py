"""In-memory stand-in for the boto3 S3 client calls that lumen.store makes."""

import io
import itertools


class NoSuchKey(Exception):
    response = {"Error": {"Code": "NoSuchKey"}}


class FakeS3:
    def __init__(self):
        self.objects = {}
        self._clock = itertools.count()

    def put_object(self, Bucket, Key, Body, ContentType=None):
        self.objects[Key] = (Body if isinstance(Body, bytes) else Body.encode(), next(self._clock))

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise NoSuchKey(Key)
        return {"Body": io.BytesIO(self.objects[Key][0])}

    def list_objects_v2(self, Bucket, Prefix, ContinuationToken=None):
        keys = sorted(k for k in self.objects if k.startswith(Prefix))
        return {"Contents": [{"Key": k, "LastModified": self.objects[k][1]} for k in keys], "IsTruncated": False}

    def delete_objects(self, Bucket, Delete, **_):
        for o in Delete["Objects"]:
            self.objects.pop(o["Key"], None)
