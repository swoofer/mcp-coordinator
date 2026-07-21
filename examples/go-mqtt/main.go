// Command go-mqtt subscribes to the mcp-coordinator embedded MQTT broker and
// prints one readable line per coordination event.
//
// It connects anonymously by default (the coordinator ships anonymous). If the
// coordinator has auth enabled (COORDINATOR_AUTH_ENABLED=true), set
// COORDINATOR_TOKEN to a Phase-1 JWT; it is sent in the MQTT CONNECT password.
//
// The coordinator publishes everything under a hardcoded org "default", so this
// example subscribes to coordinator/default/#.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// topicFilter is the subscription. The coordinator has no per-org MQTT routing
// today: every topic is literally coordinator/default/... .
const topicFilter = "coordinator/default/#"

func main() {
	broker := getenv("COORDINATOR_MQTT_URL", "mqtt://127.0.0.1:1883")
	token := os.Getenv("COORDINATOR_TOKEN") // optional Phase-1 JWT
	clientID := getenv("COORDINATOR_CLIENT_ID", "go-mqtt-subscriber")

	opts := mqtt.NewClientOptions().
		AddBroker(broker).
		SetClientID(clientID).
		SetProtocolVersion(4). // MQTT 3.1.1
		SetKeepAlive(30 * time.Second).
		SetConnectTimeout(10 * time.Second).
		SetOrderMatters(false).
		SetOnConnectHandler(func(c mqtt.Client) {
			// Subscribe on (re)connect so we recover after a broker restart.
			if t := c.Subscribe(topicFilter, 1, onMessage); t.Wait() && t.Error() != nil {
				fmt.Fprintf(os.Stderr, "subscribe failed: %v\n", t.Error())
				return
			}
			fmt.Fprintf(os.Stderr, "subscribed to %s\n", topicFilter)
		}).
		SetConnectionLostHandler(func(_ mqtt.Client, err error) {
			fmt.Fprintf(os.Stderr, "connection lost: %v\n", err)
		})

	if token != "" {
		// Username is ignored by the broker but conventionally the agent id;
		// the JWT goes in the password field.
		opts.SetUsername(clientID)
		opts.SetPassword(token)
	}

	client := mqtt.NewClient(opts)
	fmt.Fprintf(os.Stderr, "connecting to %s\n", broker)
	if t := client.Connect(); t.Wait() && t.Error() != nil {
		fmt.Fprintf(os.Stderr, "could not connect to %s: %v\n", broker, t.Error())
		os.Exit(1)
	}

	// Clean shutdown on SIGINT / SIGTERM.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	fmt.Fprintln(os.Stderr, "\nstopping subscriber.")
	client.Disconnect(250)
}

// onMessage decodes each retained/live payload and prints a readable summary.
func onMessage(_ mqtt.Client, m mqtt.Message) {
	topic := m.Topic()
	raw := m.Payload()

	// A retained coordinator/default/consultations/new with an empty payload
	// means the previous retained value was cleared. Skip it.
	if len(raw) == 0 {
		return
	}

	parts := strings.Split(topic, "/") // coordinator/default/<category>/...
	if len(parts) < 3 {
		printLine(topic, string(raw))
		return
	}

	switch parts[2] {
	case "consultations":
		printConsultation(topic, parts, raw)
	case "agents":
		printAgent(topic, parts, raw)
	case "broadcast":
		printBroadcast(topic, raw)
	default:
		// Anything else (e.g. quota/update) is printed raw so nothing is hidden.
		printLine(topic, compact(raw))
	}
}

func printConsultation(topic string, parts []string, raw []byte) {
	// coordinator/default/consultations/new
	// coordinator/default/consultations/<threadId>/<messages|status|claimed|completed>
	if len(parts) == 4 && parts[3] == "new" {
		var e struct {
			ThreadID      string   `json:"thread_id"`
			AgentID       string   `json:"agent_id"`
			Subject       string   `json:"subject"`
			TargetModules []string `json:"target_modules"`
		}
		if !decode(topic, raw, &e) {
			return
		}
		printf(topic, "NEW consultation %q by %s subject=%q modules=%s",
			e.ThreadID, e.AgentID, e.Subject, strings.Join(e.TargetModules, ","))
		return
	}

	if len(parts) < 5 {
		printLine(topic, compact(raw))
		return
	}
	threadID, kind := parts[3], parts[4]

	switch kind {
	case "messages":
		var e struct {
			AgentID string `json:"agent_id"`
			Type    string `json:"type"` // context | suggestion | warning
			Content string `json:"content"`
		}
		if !decode(topic, raw, &e) {
			return
		}
		printf(topic, "MESSAGE thread=%s from=%s [%s] %s", threadID, e.AgentID, e.Type, e.Content)
	case "status":
		var e struct {
			Status  string `json:"status"` // resolving | resolved
			Summary string `json:"summary"`
		}
		if !decode(topic, raw, &e) {
			return
		}
		printf(topic, "STATUS thread=%s -> %s %s", threadID, e.Status, e.Summary)
	case "claimed":
		var e struct {
			AgentID   string `json:"agent_id"`
			ClaimedBy string `json:"claimed_by"`
			ClaimedAt string `json:"claimed_at"`
		}
		if !decode(topic, raw, &e) {
			return
		}
		printf(topic, "CLAIMED thread=%s by=%s at=%s", threadID, e.ClaimedBy, e.ClaimedAt)
	case "completed":
		var e struct {
			AgentID     string `json:"agent_id"`
			CompletedBy string `json:"completed_by"`
			Summary     string `json:"summary"`
		}
		if !decode(topic, raw, &e) {
			return
		}
		printf(topic, "COMPLETED thread=%s by=%s %s", threadID, e.CompletedBy, e.Summary)
	default:
		printLine(topic, compact(raw))
	}
}

func printAgent(topic string, parts []string, raw []byte) {
	// coordinator/default/agents/<agentId>/status
	if len(parts) < 5 || parts[4] != "status" {
		printLine(topic, compact(raw))
		return
	}
	agentID := parts[3]
	var e struct {
		Status string `json:"status"` // online | offline
		Name   string `json:"name"`
		Reason string `json:"reason"` // set on the LWT offline message
	}
	if !decode(topic, raw, &e) {
		return
	}
	line := fmt.Sprintf("AGENT %s is %s", agentID, e.Status)
	if e.Name != "" {
		line += fmt.Sprintf(" (%s)", e.Name)
	}
	if e.Reason != "" {
		line += fmt.Sprintf(" reason=%s", e.Reason)
	}
	printf(topic, "%s", line)
}

func printBroadcast(topic string, raw []byte) {
	// coordinator/default/broadcast
	var e struct {
		AgentID string `json:"agent_id"`
		Message string `json:"message"`
	}
	if !decode(topic, raw, &e) {
		return
	}
	printf(topic, "BROADCAST from=%s %s", e.AgentID, e.Message)
}

// --- helpers ---

func decode(topic string, raw []byte, v any) bool {
	if err := json.Unmarshal(raw, v); err != nil {
		fmt.Fprintf(os.Stderr, "bad JSON on %s: %v\n", topic, err)
		printLine(topic, compact(raw))
		return false
	}
	return true
}

func printf(topic, format string, args ...any) {
	fmt.Printf("%-55s | %s\n", topic, fmt.Sprintf(format, args...))
}

func printLine(topic, body string) {
	fmt.Printf("%-55s | %s\n", topic, body)
}

// compact collapses JSON whitespace; falls back to the raw string on failure.
func compact(raw []byte) string {
	var b bytes.Buffer
	if err := json.Compact(&b, raw); err != nil {
		return string(raw)
	}
	return b.String()
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
