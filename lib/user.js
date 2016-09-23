'use strict';

var debug = require('debug')('tipbot:user');

var helpText = require('../text/txt_tao.js').userTxt;
var tao = require('./dash');


var User = function (tipbot, userId, userName, isAdmin) {
    var self = this;

    self.tipbot = tipbot;
    self.id = userId;
    self.name = userName;
    self.is_admin = isAdmin || false;
    self.handle = self.getSlackHandle();

    self.wallet = tipbot.wallet;// RPC connection to wallet
    self.blockchainUrl = 'https://chainz.cryptoid.info/tao/tx.dws?';

    self.REQUIRED_CONFIRMATIONS = 6;

    self.locked = false;  // to prevent multiple transactions
};

// send via Blockchain
function sendAmount(self, toAddress, value, cb) {
    // send  users Account to Address
    self.wallet.sendFrom(self.id, toAddress, parseFloat(tao.toTao(value)),
        function (err, tx_id) {
            if (err) {
                debug('ERROR sending via blockchain : ' + err);
                var error = 'An error prevents withdrawing.';
                cb(error, null);
                return;
            }
            var url = self.blockchainUrl + tx_id;
            var line = helpText.Withdrawal1 + tao.toTao(value) + ' ' +
                helpText.BaseCurrency + ' to ' +
                toAddress +
                helpText.WithdrawalTransaction +
                url;
            cb(null, line);

        });
}

User.prototype.updateFromMember = function (member) {
    var self = this;
    self.name = member.name;
    self.is_admin = member.is_admin;
    self.handle = self.getSlackHandle();
};


User.prototype.getBalanceLine = function (cb) {
    var self = this;
    var balanceText = '';

    self.getBalance(self.id, self.REQUIRED_CONFIRMATIONS, function (err, balance) {
        if (err) { return; }
        balanceText = self.handle + helpText.BalanceIs + balance + ' ' + helpText.BaseCurrency;
        // check for High Balance
        if (tao.toDuff(balance) >= self.tipbot.HighBalanceWarningMark) {
            // warn user
            balanceText += '\n *' + helpText.BalanceWarningHigh + '*';
        }
        // check if there is an unconfirmed balance
        self.getBalance(self.id, 1, function (err, unconfirmedBalance) {
            if (err) { return; }
            if (unconfirmedBalance !== balance) {
                // add unconfirmed balance information to the text
                balanceText += '\n' + helpText.UnconfirmedBalance1 + self.REQUIRED_CONFIRMATIONS + helpText.UnconfirmedBalance2 + unconfirmedBalance + ' ' + helpText.BaseCurrency;
            }
            cb(null, balanceText);
        });
    });
};

// reusable getBalance function
User.prototype.getBalance = function (userID, reqConfirmantions, cb) {
    var self = this;
    // debug('Get balance with ' + reqConfirmantions + ' confirmations for ' + userID);
    self.wallet.getBalance(userID, reqConfirmantions, function (err, balance) {
        if (err) {
            var errorTx = 'ERROR getting balance with ' + reqConfirmantions + ' confirmations: ' + err;
            debug(errorTx);
            cb(errorTx, null);
        } else {
            cb(null, balance);
        }
    });
};

User.prototype.tellDepositeAddress = function (cb) {
    var self = this;

    var depositAddress;
    // get all addresses in de the wallet for this user
    // should be 1 if users has already an account, if he hasn't give hem one now
    self.wallet.getAddressesByAccount(self.id, function (err, addresses) {
        if (err) { cb(err, null); }

        if (addresses !== undefined && addresses.length > 0) {
            // found an address for this userID in the wallet
            depositAddress = addresses[0]; // get first address
            debug('Existing address for ' + self.handle + '  ' + depositAddress);
            cb(null, self.handle + ' you can deposit to: ' + depositAddress);
        } else {
            // didn't find an address for this user in the wallet, create an account now
            self.wallet.getNewAddress(self.id, function (err, address) {
                if (err) { cb(err, null); }

                depositAddress = address;
                debug('New address for ' + self.handle + '  ' + depositAddress);
                cb(null, self.handle + ' you can deposit to: ' + depositAddress);
            });
        }
    });
};

User.prototype.withdraw = function (value, toAddress, walletPass, cb) {
    // value is in satochi !
    var self = this;
    // prevent multiple transactions, only continue if not already locked
    if (self.locked === true) {
        var error = self.handle + helpText.Locked;
        cb(error, null);
        return;
    }

    // lock now to prevent new transactions
    self.locked = true;

    self.getBalance(self.id, self.REQUIRED_CONFIRMATIONS, function (err, balance) {
        if (err) {
            self.locked = false;
            cb(err, null);
            return;
        }
        balance = tao.toDuff(balance);

        // check if with all (value = balance)
        if (value === balance) {
            // substract tx_fee from value
            value = balance - self.tipbot.OPTIONS.TX_FEE;
        }

        if (balance >= value + self.tipbot.OPTIONS.TX_FEE) {
            // enough balance
            if (value === balance) {
                // withdraw everything (minus the fee)
                value -= self.tipbot.OPTIONS.TX_FEE;
            }
            // unlock wallet if needed
            if (walletPass) {
                self.wallet.walletPassphrase(walletPass, 10, function (err) {
                    if (err) {
                        var error = 'ERROR could not unlock the wallet';
                        debug(error + ' : ' + err);
                        self.locked = false;
                        cb(error, null);

                        return;
                    }
                    // wallet is now unlocked for 10 seconds, move amount
                    sendAmount(self, toAddress, value, cb);
                });
            } else {

                // no wallet unlocking needed, no need to wait for the  walletPassphrase callback
                sendAmount(self, toAddress, value, cb);

            }
        } else {
            // not enough balance
            var error = helpText.InsufficientBalance1 + self.handle + helpText.InsufficientBalance2;
            cb(error, null);
        }

        //  this transaction is done, clear lock to allow new transactions

        self.locked = false;
    });
};

User.prototype.send = function (sendToUser, value, cb) {
    var self = this;

    var error = '';
    // prevent multiple transactions, only continue if not already locked
    if (self.locked === true) {
        error = self.handle + helpText.Locked;
        cb(error, null);
        return;

    }
    // lock now to prevent new transactions

    self.locked = true;

    // check balance before sending amount to prevent negative saldo
    self.wallet.getBalance(self.id, self.REQUIRED_CONFIRMATIONS, function (err, balance) {
        balance = tao.toDuff(balance);
        if (err) {
            debug('ERROR checking balance before sending tip: ' + err);
            var error = 'ERROR checking balance before sending tip.';
            self.locked = false; //  this transaction is done, clear lock to allow new transactions
            cb(error, null);
            return;
        }
        if (balance < value) {
            error = helpText.InsufficientBalance1 + self.handle + helpText.InsufficientBalance2;
            self.locked = false; //  this transaction is done, clear lock to allow new transactions
            cb(error, null);
            return;
        }

        // use a in wallet transfer
        self.wallet.move(self.id, sendToUser.id, parseFloat(tao.toTao(value)), function (err, result) {
            if (err) {
                debug('ERROR: moving between account (' + self.id + ') to acount (' + sendToUser.id + ')' + err);
                error = helpText.SendOops1 + tao.toTao(value) + ' ' + helpText.BaseCurrency + helpText.SendOops2 + sendToUser.name + '';
                self.locked = false; //  this transaction is done, clear lock to allow new transactions
                cb(error, null);

                return;
            }

            if (result === true) {

                debug('Sending Tip: Moved ' + tao.toTao(value) + ' Tao from ' + self.handle + ' to ' + sendToUser.name + '(' + sendToUser.id + ')');
                // prepare message in channel where Tip command was issued
                var responses = {
                    public: helpText.SendPublicMessage1 + self.handle + helpText.SendPublicMessage2 + sendToUser.handle
                };
                //  prepare message to recieving user to inform of tip
                responses.privateToReciever = helpText.SendPrivateMssRecievingUser1 + sendToUser.handle +
                    helpText.SendPrivateMssRecievingUser2 + tao.toTao(value) + ' ' +
                    helpText.BaseCurrency + helpText.SendPrivateMssRecievingUser3 + self.handle + ' !';
                // prepare message to sending user to inform of new balance
                self.getBalanceLine(function (err, balanceLine) {
                    responses.privateToSender = self.handle + helpText.SendPrivateMssSendingUser + balanceLine;
                    self.locked = false; //  this transaction is done, clear lock to allow new transactions
                    // all responses are prepared, send them in tipbot.js
                    cb(null, responses);
                });
            } else {
                // result == false
                error = helpText.SendOops1 + tao.toTao(value) + ' ' + helpText.BaseCurrency + helpText.SendOops2 + sendToUser.name + '';
                self.locked = false;  //  this transaction is done, clear lock to allow new transactions
                cb(error, null);
            }

        });
    });

};

User.prototype.getSlackHandle = function () {
    var self = this;
    return '<@' + self.id + '|' + self.name + '>';
};

User.fromMember = function (tipbot, member) {
    var user = new User(tipbot, member.id, member.name, member.is_admin);
    return user;
};

module.exports = User;
