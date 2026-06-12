# Dogfood the workflow kit before building init

PullOps should first commit and run its own Workflow Kit in this repository before productizing installation through PullOps Init. Proving the GitHub Actions behavior, skills, labels, and runner commands in a real repository reduces the risk of building an init command around untested workflow assumptions.
