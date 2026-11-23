import { useDockerContext } from '@conservationtv/gatekeeper/testing';

// Each test worker starts its own containers: point Testcontainers at the Docker the `docker` CLI uses first.
useDockerContext();
