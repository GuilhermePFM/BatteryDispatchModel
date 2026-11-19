"""The solver against LocalStack: poll the jobs queue, call the Lambda's handler.

    QUEUE_URL=... TABLE_NAME=... DATA_BUCKET=... python local_worker.py

It mimics the SQS event source with batch size 1: one message at a time,
handed to :func:`handler.handler` as a synthesised SQS event, and deleted only
once the handler returns. A raised error leaves the message to the redrive
policy (``maxReceiveCount = 1``); rather than wait out the visibility timeout,
the worker makes it visible again at once, so the next receive moves it to the
DLQ straight away.
"""

from __future__ import annotations

import logging
import os

import boto3

import handler

log = logging.getLogger("solver.local")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    sqs = boto3.client("sqs")
    queue_url = os.environ["QUEUE_URL"]
    queue_arn = sqs.get_queue_attributes(QueueUrl=queue_url, AttributeNames=["QueueArn"])[
        "Attributes"
    ]["QueueArn"]
    log.info("polling %s", queue_url)
    while True:
        reply = sqs.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=1,
            WaitTimeSeconds=20,
            MessageSystemAttributeNames=["All"],
        )
        for message in reply.get("Messages", []):
            event = {"Records": [_record(message, queue_arn, sqs.meta.region_name)]}
            try:
                handler.handler(event)
            except Exception:
                log.exception(
                    "message %s failed: leaving it to the redrive policy", message["MessageId"]
                )
                sqs.change_message_visibility(
                    QueueUrl=queue_url, ReceiptHandle=message["ReceiptHandle"], VisibilityTimeout=0
                )
                continue
            sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=message["ReceiptHandle"])


def _record(message: dict[str, object], queue_arn: str, region: str) -> dict[str, object]:
    """One record of an SQS event, as Lambda's event source shapes it."""
    return {
        "messageId": message["MessageId"],
        "receiptHandle": message["ReceiptHandle"],
        "body": message["Body"],
        "attributes": message.get("Attributes", {}),
        "messageAttributes": {},
        "md5OfBody": message["MD5OfBody"],
        "eventSource": "aws:sqs",
        "eventSourceARN": queue_arn,
        "awsRegion": region,
    }


if __name__ == "__main__":
    main()
