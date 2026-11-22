package main

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
)

type fakeSSM map[string]string

func (f fakeSSM) GetParameter(_ context.Context, in *ssm.GetParameterInput, _ ...func(*ssm.Options)) (*ssm.GetParameterOutput, error) {
	v, ok := f[aws.ToString(in.Name)]
	if !ok {
		return nil, errors.New("ParameterNotFound")
	}
	return &ssm.GetParameterOutput{Parameter: &ssmtypes.Parameter{Value: aws.String(v)}}, nil
}

func TestSSMParameter(t *testing.T) {
	f := fakeSSM{"/batteryplan/cognito-client-id": "abc123", "/empty": ""}
	if v, err := ssmParameter(context.Background(), f, "/batteryplan/cognito-client-id"); err != nil || v != "abc123" {
		t.Errorf("%q %v", v, err)
	}
	for _, name := range []string{"/missing", "/empty"} {
		if _, err := ssmParameter(context.Background(), f, name); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}
